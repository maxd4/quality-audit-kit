const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { discover, findRepositoryRoot, resolveLocalBinary } = require('./discovery');
const {
  DECISIONS,
  assessMeasuredRun,
  compareRuns,
  createBaseline,
  evaluateDecisionStaleness,
  normalizePolicy,
  policyRelaxations,
} = require('./history');
const { loadOrRunScanner } = require('./scanners');
const {
  buildStructuredReport,
  createBundle,
  renderMarkdown,
  renderTerminal,
  verifyBundle,
  writeOutput,
} = require('./report');
const { buildPlan, nextLot, renderPlanMarkdown } = require('./planner');
const { buildThresholdConfig, recommendThresholds, renderThresholdsMarkdown } = require('./thresholds');
const { executeFix, runValidations, verifyFixResult } = require('./fix');
const { buildSarif, importSarifFile } = require('./sarif');
const { connectSonar, importSonar } = require('./sonar');
const {
  TEMPLATE_FILES,
  buildAgentPrompt,
  diffPreview,
  extractFactChanges,
  mergeAgentsLink,
  mergeManagedDocument,
  readAgentCustomization,
  refreshManagedDocument,
  renderTemplate,
  writeIfChanged,
} = require('./templates');

const SCANNERS = ['knip', 'jscpd'];
const CONFIG_FILENAME = 'quality-audit-kit.config.json';
const DEFAULT_BASELINE_FILENAME = 'quality-audit-kit.baseline.json';
const DEFAULT_DECISIONS_FILENAME = 'quality-audit-kit.decisions.json';

function parseArguments(argv) {
  const [command = 'help', ...tokens] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals >= 0) {
      options[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith('--') && !['help', 'force', 'preview', 'update-templates', 'link-agents', 'replace', 'next', 'apply', 'approve', 'execute'].includes(name)) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { command, options, positional };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonAtomicReplace(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lockPath = `${target}.qak-lock`;
  const tempPath = `${target}.qak-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const lockToken = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  let lockFd;
  let tempFd;
  try {
    const existing = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symbolic-link configuration file.');
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockFd, lockToken, 'utf8');
      fs.fsyncSync(lockFd);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Refusing concurrent configuration write: ${target}`);
      throw error;
    }
    tempFd = fs.openSync(tempPath, 'wx');
    const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.writeSync(tempFd, content, 0, content.length);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tempPath, target);
  } finally {
    if (tempFd !== undefined) { try { fs.closeSync(tempFd); } catch {} }
    try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch {}
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try {
        if (fs.readFileSync(lockPath, 'utf8') === lockToken) fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}

function scannerSelection(value) {
  if (value === undefined) return new Set();
  if (value === true) return new Set(SCANNERS);
  const selected = String(value).split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = selected.filter((name) => !SCANNERS.includes(name));
  if (unknown.length) throw new Error(`Unknown scanner(s): ${unknown.join(', ')}`);
  return new Set(selected);
}

function gitCommit(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  const commit = String(result.stdout || '').trim();
  return /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
}

function sourceRevisionForExecution(discovery) {
  if (discovery.git?.worktree === 'CLEAN' && discovery.git.head) {
    return {
      status: 'VERIFIED',
      sha: discovery.git.head,
      basis: 'Scanner executed against a clean worktree whose content is represented by HEAD.',
    };
  }
  return {
    status: 'UNVERIFIED',
    sha: null,
    basis: discovery.git?.worktree === 'DIRTY'
      ? 'Scanner executed against a live worktree with uncommitted changes; no single Git revision represents the measured content.'
      : 'Scanner executed against a source tree without a verified clean Git revision.',
  };
}

function createRunId() {
  return `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function loadConfig(root) {
  const configPath = path.join(root, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return {};
  const config = readJson(configPath);
  if (!config || typeof config !== 'object') throw new Error(`${CONFIG_FILENAME} must contain a JSON object`);
  return config;
}

function configuredQuality(root, config) {
  const quality = config.quality && typeof config.quality === 'object' ? config.quality : {};
  return {
    baseline: quality.baseline || DEFAULT_BASELINE_FILENAME,
    decisions: quality.decisions || DEFAULT_DECISIONS_FILENAME,
    ratchet: normalizePolicy(quality.ratchet || {}),
  };
}

function resolveRepositoryFile(root, value, fallback) {
  const selected = value === undefined || value === true ? fallback : String(value);
  const candidate = path.resolve(root, selected);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Quality Audit Kit artifact paths must remain inside the analyzed repository.');
  }
  return candidate;
}

function emptyDecisionBundle() {
  return { schemaVersion: '0.1-draft', decisions: [] };
}

function loadDecisionBundle(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return emptyDecisionBundle();
  const bundle = readJson(filePath);
  if (!bundle || bundle.schemaVersion !== '0.1-draft' || !Array.isArray(bundle.decisions)) {
    throw new Error('Decision file must contain schemaVersion 0.1-draft and a decisions array.');
  }
  return bundle;
}

function notEvaluatedComparison(reason, run, policy) {
  return {
    status: 'NOT_EVALUATED',
    compatible: false,
    reasons: [reason],
    baselineRunId: null,
    currentRunId: run?.runId || null,
    matches: [],
    resolved: [],
    staleDecisions: [],
    qualityGate: {
      status: 'NOT_EVALUATED',
      policy: normalizePolicy(policy),
      blockedReasons: [],
      newBlockingFindings: [],
      proposals: [],
      policyRelaxation: { relaxed: false, reasons: [] },
    },
  };
}

function resolveApprovedTargetFile(root, value) {
  const candidate = path.resolve(root, value);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Agent prompt output must remain inside the analyzed repository.');
  }
  return candidate;
}

const PLAN_STATUSES = new Set(['READY', 'NEEDS_TRIAGE', 'BLOCKED_BY_MEASUREMENT', 'NEEDS_REVIEW', 'NO_ACTIONABLE_FINDINGS']);
const LOT_STATUSES = new Set(['READY', 'NEEDS_TRIAGE', 'CYCLE_REQUIRES_REVIEW']);
const PLAN_KEYS = ['schemaVersion', 'planVersion', 'planType', 'planId', 'runId', 'repository', 'inputScope', 'reproducible', 'status', 'ordering', 'measurementFailures', 'warnings', 'excludedFindings', 'dependencyCycles', 'lots', 'prompts'];
const LOT_KEYS = ['id', 'category', 'categoryLabel', 'title', 'status', 'findings', 'files', 'responsibility', 'cause', 'dependencies', 'dependencyReasons', 'unresolvedDependencies', 'factors', 'rationale', 'invariants', 'checks', 'stopCondition', 'relationEvidence', 'priority', 'objective', 'prompt'];
const PROMPT_KEYS = ['lotId', 'priority', 'category', 'fileName', 'content'];

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) throw new Error(`${label} has an invalid structure.`);
}

function isSafePromptFileName(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value)
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\')
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !path.win32.parse(value).root;
}

function promptFileKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function validatePlanStructure(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Plan must be a JSON object.');
  exactKeys(plan, PLAN_KEYS, 'Plan');
  if (plan.schemaVersion !== '0.1-draft' || plan.planVersion !== '0.1-draft' || plan.planType !== 'QUALITY_CORRECTION_PLAN') throw new Error('Plan contract version or type is invalid.');
  if (typeof plan.planId !== 'string' || !/^plan-[a-f0-9]{16}$/.test(plan.planId)) throw new Error('Plan identifier is invalid.');
  if (typeof plan.runId !== 'string' || plan.runId.length < 8) throw new Error('Plan run identifier is invalid.');
  if (!plan.repository || typeof plan.repository !== 'object' || Array.isArray(plan.repository) || typeof plan.repository.name !== 'string' || !plan.repository.name) throw new Error('Plan repository identity is invalid.');
  if (typeof plan.inputScope !== 'string' || typeof plan.reproducible !== 'boolean' || !PLAN_STATUSES.has(plan.status)) throw new Error('Plan status or context is invalid.');
  if (!plan.ordering || typeof plan.ordering !== 'object' || plan.ordering.noOpaqueScore !== true || typeof plan.ordering.rule !== 'string' || !Array.isArray(plan.ordering.categories)) throw new Error('Plan ordering contract is invalid.');
  if (!Array.isArray(plan.measurementFailures) || !Array.isArray(plan.warnings) || !plan.warnings.every((item) => typeof item === 'string') || !Array.isArray(plan.excludedFindings) || !Array.isArray(plan.dependencyCycles) || !plan.dependencyCycles.every((cycle) => Array.isArray(cycle) && cycle.every((item) => typeof item === 'string')) || !Array.isArray(plan.lots) || !Array.isArray(plan.prompts)) throw new Error('Plan collections are invalid.');
  const lotIds = new Set();
  const lotsById = new Map();
  const priorities = new Set();
  for (const lot of plan.lots) {
    if (!lot || typeof lot !== 'object' || Array.isArray(lot)) throw new Error('Plan contains an invalid correction lot.');
    exactKeys(lot, LOT_KEYS, 'Correction lot');
    if (typeof lot.id !== 'string' || !/^lot-[a-f0-9]{16}$/.test(lot.id) || lotIds.has(lot.id)) throw new Error('Plan contains a duplicate or invalid correction lot identifier.');
    if (!LOT_STATUSES.has(lot.status) || !Number.isInteger(lot.priority) || lot.priority < 1 || priorities.has(lot.priority)) throw new Error('Plan contains an invalid or duplicate lot priority.');
    if (!Array.isArray(lot.findings) || !Array.isArray(lot.files) || !lot.files.every((file) => typeof file === 'string') || !Array.isArray(lot.dependencies) || !Array.isArray(lot.dependencyReasons) || !Array.isArray(lot.unresolvedDependencies) || !Array.isArray(lot.rationale) || !Array.isArray(lot.invariants) || !Array.isArray(lot.checks) || !Array.isArray(lot.relationEvidence) || typeof lot.prompt !== 'string' || typeof lot.objective !== 'string' || typeof lot.stopCondition !== 'string') throw new Error(`Correction lot ${lot.id} has an invalid structure.`);
    lotIds.add(lot.id);
    lotsById.set(lot.id, lot);
    priorities.add(lot.priority);
  }
  const promptNames = new Set();
  if (plan.prompts.length !== plan.lots.length) throw new Error('Plan prompt and lot counts do not agree.');
  const promptsByLot = new Map();
  for (const prompt of plan.prompts) {
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) throw new Error('Plan contains an invalid prompt.');
    exactKeys(prompt, PROMPT_KEYS, 'Plan prompt');
    const lot = lotsById.get(prompt.lotId);
    if (!lot || !Number.isInteger(prompt.priority) || prompt.priority < 1 || typeof prompt.category !== 'string' || typeof prompt.content !== 'string' || !prompt.content) throw new Error('Plan prompt metadata is invalid.');
    if (promptsByLot.has(prompt.lotId)) throw new Error(`Plan lot ${prompt.lotId} must have exactly one prompt.`);
    if (prompt.priority !== lot.priority) throw new Error(`Plan prompt priority does not match lot ${prompt.lotId}.`);
    if (prompt.category !== lot.category) throw new Error(`Plan prompt category does not match lot ${prompt.lotId}.`);
    if (prompt.content !== lot.prompt) throw new Error(`Plan prompt content does not match lot ${prompt.lotId}.`);
    promptsByLot.set(prompt.lotId, prompt);
    if (!isSafePromptFileName(prompt.fileName)) throw new Error(`Plan prompt filename is unsafe: ${String(prompt.fileName)}`);
    if (promptNames.has(promptFileKey(prompt.fileName))) throw new Error(`Plan contains duplicate prompt filename: ${prompt.fileName}`);
    promptNames.add(promptFileKey(prompt.fileName));
  }
  for (const lot of plan.lots) if (!promptsByLot.has(lot.id)) throw new Error(`Plan lot ${lot.id} must have exactly one prompt.`);
  return plan;
}

function sameResolvedPath(left, right) {
  const normalize = (value) => path.normalize(value);
  if (process.platform === 'win32') return normalize(left).toLowerCase() === normalize(right).toLowerCase();
  return normalize(left) === normalize(right);
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function preparePromptExport(outputDirectory, prompts) {
  const lexicalRoot = path.resolve(outputDirectory);
  const names = new Set();
  for (const prompt of prompts) {
    if (!isSafePromptFileName(prompt.fileName)) throw new Error(`Plan prompt filename is unsafe: ${String(prompt.fileName)}`);
    if (names.has(promptFileKey(prompt.fileName))) throw new Error(`Plan contains duplicate prompt filename: ${prompt.fileName}`);
    names.add(promptFileKey(prompt.fileName));
  }
  fs.mkdirSync(lexicalRoot, { recursive: true });
  const rootStat = fs.lstatSync(lexicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Prompt export directory must be a real directory, not a symbolic link.');
  const realRoot = fs.realpathSync(lexicalRoot);
  if (!sameResolvedPath(realRoot, lexicalRoot)) throw new Error('Prompt export directory resolves through a symbolic link.');
  const targets = [];
  for (const prompt of prompts) {
    const target = path.resolve(lexicalRoot, prompt.fileName);
    if (!pathInside(lexicalRoot, target)) throw new Error(`Prompt export destination escapes the authorized directory: ${prompt.fileName}`);
    const parentReal = fs.realpathSync(path.dirname(target));
    if (!sameResolvedPath(parentReal, realRoot)) throw new Error(`Prompt export destination resolves outside the authorized directory: ${prompt.fileName}`);
    let targetStat;
    try { targetStat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (targetStat) throw new Error(`Refusing to overwrite an existing or protected prompt destination: ${prompt.fileName}`);
    targets.push({ prompt, target });
  }
  return { lexicalRoot, targets };
}

function discoveryForOutput(discovery) {
  return {
    repositoryRoot: '.',
    packageManager: discovery.packageManager,
    languages: discovery.languages,
    workspaces: discovery.workspaces,
    scanners: discovery.scanners.map(({ name, installed, configuration, packageConfiguration, scripts }) => ({
      name,
      installed,
      configuration,
      packageConfiguration,
      scripts,
    })),
    configurations: discovery.configurations,
    scripts: discovery.scripts,
    projectFiles: discovery.projectFiles,
    git: discovery.git,
  };
}

async function scanCommand(positional, options) {
  const target = findRepositoryRoot(positional[0] || process.cwd());
  const discovery = discover(target);
  const contextCommitSha = gitCommit(target);
  const config = loadConfig(target);
  const quality = configuredQuality(target, config);
  const executeScanners = scannerSelection(options.run);
  const explicitReports = {
    knip: options['knip-report'],
    jscpd: options['jscpd-report'],
  };
  const findings = [];
  const engines = [];
  const diagnostics = [];

  for (const scanner of SCANNERS) {
    const scannerConfig = config.scanners?.[scanner] || {};
    const configuredReport = scannerConfig.report && fs.existsSync(path.resolve(target, scannerConfig.report))
      ? scannerConfig.report
      : undefined;
    const reportPath = explicitReports[scanner] || configuredReport;
    const binary = resolveLocalBinary(target, scanner);
    const result = await loadOrRunScanner({
      root: target,
      scanner,
      explicitReport: reportPath,
      executeScanner: executeScanners.has(scanner),
      binary,
      executionSourceRevision: sourceRevisionForExecution(discovery),
    });
    const engine = {
      name: scanner,
      measurementStatus: result.status,
      gateOutcome: result.gateOutcome,
      sourceRevision: result.sourceRevision,
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      scope: '.',
    };
    engines.push(engine);
    findings.push(...(result.findings || []));
  }

  if (options['sarif-report'] !== undefined) {
    const selected = options['sarif-report'] === true ? 'results.sarif' : String(options['sarif-report']);
    const sarifPath = path.isAbsolute(selected) ? selected : path.resolve(target, selected);
    try {
      const result = importSarifFile(target, sarifPath);
      engines.push(result.engine);
      findings.push(...result.findings);
      diagnostics.push(...result.diagnostics);
    } catch (error) {
      engines.push({ name: 'sarif', measurementStatus: 'FAILURE', gateOutcome: 'NOT_EVALUATED', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'SARIF import failed before a source revision could be established.' }, scope: '.', diagnostic: error.message });
    }
  }

  const run = {
    schemaVersion: '0.1-draft',
    runId: createRunId(),
    repository: {
      name: discovery.repositoryName,
      commitSha: contextCommitSha,
      contextCommitSha,
      sourceScopeDescription: 'Live repository workspace inspected without modifying source files. commitSha/contextCommitSha identify Git context only; each engine carries independent sourceRevision evidence.',
    },
    inputScope: 'WORKTREE_LIVE',
    reproducible: false,
    generatedAt: new Date().toISOString(),
    discovery: discoveryForOutput(discovery),
    engines,
    findings,
    ...(diagnostics.length ? { diagnostics } : {}),
  };

  const configuredBaseline = config.quality?.baseline;
  const baselinePath = options.baseline !== undefined
    ? resolveRepositoryFile(target, options.baseline, quality.baseline)
    : configuredBaseline && fs.existsSync(resolveRepositoryFile(target, configuredBaseline, quality.baseline))
      ? resolveRepositoryFile(target, configuredBaseline, quality.baseline)
      : null;
  if (baselinePath) {
    if (!fs.existsSync(baselinePath)) {
      run.comparison = notEvaluatedComparison(`Baseline file does not exist: ${path.relative(target, baselinePath)}`, run, quality.ratchet);
      run.qualityGate = run.comparison.qualityGate;
    } else {
      const baseline = readJson(baselinePath);
      const decisionsPath = options.decisions !== undefined
        ? resolveRepositoryFile(target, options.decisions, quality.decisions)
        : fs.existsSync(resolveRepositoryFile(target, quality.decisions, quality.decisions))
          ? resolveRepositoryFile(target, quality.decisions, quality.decisions)
          : null;
      const decisions = loadDecisionBundle(decisionsPath);
      const comparison = compareRuns(baseline, run, decisions, quality.ratchet);
      if (comparison.classifiedFindings) run.findings = comparison.classifiedFindings;
      const { classifiedFindings, qualityGate, ...serializableComparison } = comparison;
      run.comparison = serializableComparison;
      run.qualityGate = qualityGate;
    }
  }

  const content = `${JSON.stringify(run, null, 2)}\n`;
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
  if (engines.some((engine) => ['FAILURE', 'PARTIAL'].includes(engine.measurementStatus))
    || run.comparison?.status === 'NOT_EVALUATED'
    || ['FAIL', 'NOT_EVALUATED'].includes(run.qualityGate?.status)) process.exitCode = 2;
  return run;
}

function initTemplates(target, discovery, options) {
  const mode = options.templates || 'deterministic';
  if (!['deterministic', 'none'].includes(mode)) throw new Error(`Unsupported template mode: ${mode}`);
  if (mode === 'none') return { mode, files: [], agent: null, diffs: [] };

  const agent = options.agent;
  if (agent && agent !== 'codex') throw new Error(`Unsupported agent: ${agent}`);
  if (options['agent-input'] && agent !== 'codex') throw new Error('--agent-input requires --agent codex.');
  if (options['agent-prompt'] && agent !== 'codex') throw new Error('--agent-prompt requires --agent codex.');

  const customizations = options['agent-input']
    ? readAgentCustomization(path.resolve(target, options['agent-input']))
    : {};
  const files = [];
  const diffs = [];
  for (const [kind, filename] of Object.entries(TEMPLATE_FILES)) {
    const filePath = path.join(target, filename);
    const exists = fs.existsSync(filePath);
    const proposed = renderTemplate(kind, discovery, customizations[kind]);
    if (exists && !options['update-templates']) {
      files.push({ file: filename, status: 'EXISTING_UNCHANGED', reason: 'existing documents are protected by default' });
      continue;
    }
    const existing = exists ? fs.readFileSync(filePath, 'utf8') : null;
    const merged = mergeManagedDocument(existing, proposed);
    if (merged.unsafe) {
      files.push({ file: filename, status: 'BLOCKED', reason: merged.reason });
      continue;
    }
    if (options.preview) {
      diffs.push(diffPreview(filename, existing || '', merged.content));
      files.push({ file: filename, status: merged.changed ? 'PREVIEW' : 'UNCHANGED' });
      continue;
    }
    if (merged.changed) writeIfChanged(filePath, merged.content);
    files.push({ file: filename, status: merged.created ? 'CREATED' : merged.changed ? 'UPDATED' : 'UNCHANGED' });
  }

  let agentResult = null;
  if (agent === 'codex') {
    agentResult = {
      provider: 'codex',
      status: options['agent-input'] ? 'APPLIED_FROM_EXPLICIT_INPUT' : 'NOT_EXECUTED',
      execution: 'CLI does not execute an agent or contact a service implicitly.',
    };
    if (options['agent-prompt']) {
      const promptPath = resolveApprovedTargetFile(target, options['agent-prompt']);
      const prompt = buildAgentPrompt(discovery);
      if (!options.preview) writeIfChanged(promptPath, `${prompt}\n`);
      agentResult.prompt = path.relative(target, promptPath).split(path.sep).join('/');
    }
  }

  if (options['link-agents']) {
    const agentsPath = path.join(target, 'AGENTS.md');
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
    const merged = mergeAgentsLink(existing);
    if (merged.unsafe) {
      files.push({ file: 'AGENTS.md', status: 'BLOCKED', reason: merged.reason });
    } else if (merged.skipped) {
      files.push({ file: 'AGENTS.md', status: 'SKIPPED', reason: merged.reason });
    } else if (options.preview) {
      diffs.push(diffPreview('AGENTS.md', existing, merged.content));
      files.push({ file: 'AGENTS.md', status: merged.changed ? 'PREVIEW' : 'UNCHANGED' });
    } else {
      if (merged.changed) writeIfChanged(agentsPath, merged.content);
      files.push({ file: 'AGENTS.md', status: merged.changed ? 'UPDATED' : 'UNCHANGED' });
    }
  }

  return { mode, files, agent: agentResult, diffs };
}

function initCommand(positional, options) {
  const target = findRepositoryRoot(positional[0] || process.cwd());
  const configPath = path.join(target, CONFIG_FILENAME);
  const discovery = discover(target);
  const config = {
    version: '0.1-draft',
    outputDirectory: 'quality-audit-kit',
    scanners: {
      knip: { report: 'knip-report.json' },
      jscpd: { report: 'jscpd-report.json' },
    },
    quality: {
      baseline: DEFAULT_BASELINE_FILENAME,
      decisions: DEFAULT_DECISIONS_FILENAME,
      ratchet: {
        blockingSeverities: ['HIGH', 'CRITICAL'],
        maxNewBlockingFindings: 0,
        maxMeasuredFindings: null,
      },
    },
  };
  const configExists = fs.existsSync(configPath);
  const configStatus = options.preview
    ? 'PREVIEW'
    : options.force || !configExists
      ? 'WRITTEN'
      : 'EXISTING_UNCHANGED';
  if (!options.preview && (options.force || !configExists)) writeJson(configPath, config);
  const templates = initTemplates(target, discovery, options);
  process.stdout.write(`${JSON.stringify({
    command: 'init',
    config: CONFIG_FILENAME,
    configStatus,
    repository: discovery.repositoryName,
    packageManager: discovery.packageManager,
    workspaces: discovery.workspaces,
    scanners: discovery.scanners,
    templates,
  }, null, 2)}\n`);
  if (templates.files.some((file) => file.status === 'BLOCKED')) process.exitCode = 2;
}

function contextRefreshCommand(positional, options) {
  const target = findRepositoryRoot(positional[0] || process.cwd());
  const discovery = discover(target);
  const files = [];
  const changedFacts = [];
  const contradictions = [];
  for (const [kind, filename] of Object.entries(TEMPLATE_FILES)) {
    const filePath = path.join(target, filename);
    if (!fs.existsSync(filePath)) {
      files.push({ file: filename, status: 'NOT_INITIALIZED' });
      continue;
    }
    const existing = fs.readFileSync(filePath, 'utf8');
    const proposed = renderTemplate(kind, discovery);
    const facts = extractFactChanges(existing, proposed, kind);
    const refreshed = refreshManagedDocument(existing, proposed, kind);
    if (refreshed.unsafe) {
      files.push({ file: filename, status: 'BLOCKED', reason: refreshed.reason, changedFacts: facts.changedFacts, contradictions: facts.contradictions });
      changedFacts.push(...facts.changedFacts.map((change) => ({ file: filename, ...change })));
      contradictions.push(...facts.contradictions.map((contradiction) => ({ file: filename, ...contradiction })));
      continue;
    }
    changedFacts.push(...facts.changedFacts.map((change) => ({ file: filename, ...change })));
    contradictions.push(...facts.contradictions.map((contradiction) => ({ file: filename, ...contradiction })));
    if (options.preview) {
      files.push({
        file: filename,
        status: refreshed.changed ? 'PREVIEW' : 'UNCHANGED',
        changedFacts: facts.changedFacts,
        contradictions: facts.contradictions,
        ...(refreshed.changed ? { diff: diffPreview(filename, existing, refreshed.content) } : {}),
      });
      continue;
    }
    if (refreshed.changed) writeIfChanged(filePath, refreshed.content);
    files.push({
      file: filename,
      status: refreshed.changed ? 'UPDATED_FACTS' : 'UNCHANGED',
      changedFacts: facts.changedFacts,
      contradictions: facts.contradictions,
    });
  }
  const status = files.some((file) => file.status === 'BLOCKED')
    ? 'BLOCKED'
    : contradictions.length
      ? 'CONTRADICTIONS'
      : files.some((file) => file.status === 'NOT_INITIALIZED')
        ? 'NOT_INITIALIZED'
      : files.some((file) => file.status === 'UPDATED_FACTS' || file.status === 'PREVIEW')
        ? options.preview ? 'PREVIEW' : 'UPDATED'
        : 'UNCHANGED';
  process.stdout.write(`${JSON.stringify({
    command: 'context refresh',
    repository: discovery.repositoryName,
    status,
    preview: Boolean(options.preview),
    files,
    changedFacts,
    contradictions,
  }, null, 2)}\n`);
  if (status === 'BLOCKED' || status === 'CONTRADICTIONS' || status === 'NOT_INITIALIZED') process.exitCode = 2;
}

function baselineCommand(positional, options) {
  const target = findRepositoryRoot(options.repository || process.cwd());
  const config = loadConfig(target);
  const quality = configuredQuality(target, config);
  const input = positional[0] || options.run;
  if (!input) throw new Error('baseline requires an audit run JSON path.');
  const run = readJson(path.resolve(process.cwd(), input));
  const eligibility = assessMeasuredRun(run, 'source run');
  const outputPath = resolveRepositoryFile(target, options.output, quality.baseline);
  if (!eligibility.eligible) {
    process.stdout.write(`${JSON.stringify({ command: 'baseline', status: 'NOT_ELIGIBLE', reasons: eligibility.reasons, output: path.relative(target, outputPath).split(path.sep).join('/') }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const existing = fs.existsSync(outputPath) ? readJson(outputPath) : null;
  if (existing && !options.replace) {
    process.stdout.write(`${JSON.stringify({ command: 'baseline', status: 'EXISTS', output: path.relative(target, outputPath).split(path.sep).join('/'), existingRunId: existing.runId || null, reason: 'Baseline replacement requires explicit --replace; no baseline was changed.' }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  if (existing && existing.baseline?.kind !== 'QUALITY_BASELINE') throw new Error('Existing baseline artifact is not a Quality Audit Kit baseline.');
  if (existing) {
    const relaxation = policyRelaxations(existing.baseline.policySnapshot, quality.ratchet);
    if (relaxation.relaxed) {
      process.stdout.write(`${JSON.stringify({ command: 'baseline', status: 'POLICY_RELAXATION_BLOCKED', reasons: relaxation.reasons, output: path.relative(target, outputPath).split(path.sep).join('/') }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const next = createBaseline(run, existing, quality.ratchet);
  if (options.preview) {
    process.stdout.write(`${JSON.stringify({
      command: 'baseline',
      status: 'PREVIEW',
      output: path.relative(target, outputPath).split(path.sep).join('/'),
      replacingRunId: existing?.runId || null,
      runId: run.runId,
      historyCount: next.baseline.history.length,
      diff: diffPreview(path.relative(target, outputPath), existing ? JSON.stringify(existing, null, 2) : '', JSON.stringify(next, null, 2)),
    }, null, 2)}\n`);
    return;
  }
  writeJson(outputPath, next);
  process.stdout.write(`${JSON.stringify({
    command: 'baseline',
    status: existing ? 'REPLACED' : 'CREATED',
    output: path.relative(target, outputPath).split(path.sep).join('/'),
    runId: run.runId,
    historyCount: next.baseline.history.length,
    policy: next.baseline.policySnapshot,
  }, null, 2)}\n`);
}

function parseEvidence(options) {
  if (options['evidence-file']) {
    const evidence = readJson(path.resolve(process.cwd(), options['evidence-file']));
    if (!Array.isArray(evidence)) throw new Error('--evidence-file must contain an array.');
    return evidence;
  }
  if (options.evidence) {
    const parts = String(options.evidence).split('|');
    if (parts.length !== 3) throw new Error('--evidence format is TYPE|REFERENCE|OUTCOME.');
    return [{ type: parts[0], reference: parts[1], outcome: parts[2] }];
  }
  if (options['evidence-type'] || options['evidence-reference'] || options['evidence-outcome']) {
    return [{
      type: options['evidence-type'],
      reference: options['evidence-reference'],
      outcome: options['evidence-outcome'],
    }];
  }
  throw new Error('triage decisions require evidence.');
}

function validateDecision(decision) {
  if (!DECISIONS.includes(decision.decision)) throw new Error(`Unsupported decision: ${decision.decision}. Use ${DECISIONS.join(', ')}.`);
  if (!decision.findingId || !decision.reason || !decision.reviewer) throw new Error('A triage decision requires finding, reason and reviewer.');
  if (!/^[a-f0-9]{40}$/i.test(String(decision.reviewedRevision || ''))) throw new Error('reviewedRevision must be a 40-character Git SHA.');
  if (!Array.isArray(decision.evidence) || decision.evidence.length === 0) throw new Error('A triage decision requires at least one evidence item.');
  const evidenceTypes = ['SOURCE_INSPECTION', 'STATIC_CONTRACT', 'EXECUTED_BEHAVIOR', 'INTEGRATION_PROOF', 'UNKNOWN'];
  const outcomes = ['PASS', 'FAIL', 'UNKNOWN'];
  for (const evidence of decision.evidence) {
    if (!evidenceTypes.includes(evidence.type) || !evidence.reference || !outcomes.includes(evidence.outcome)) throw new Error('Each evidence item requires a valid type, reference and outcome.');
  }
  if (decision.reviewAfter && !/^\d{4}-\d{2}-\d{2}$/.test(decision.reviewAfter)) throw new Error('reviewAfter must use YYYY-MM-DD.');
}

function triageCommand(positional, options) {
  const target = findRepositoryRoot(options.repository || process.cwd());
  const config = loadConfig(target);
  const quality = configuredQuality(target, config);
  const input = positional[0] || options.run;
  if (!input) throw new Error('triage requires an audit run JSON path.');
  const run = readJson(path.resolve(process.cwd(), input));
  const baselinePath = options.baseline !== undefined
    ? resolveRepositoryFile(target, options.baseline, quality.baseline)
    : fs.existsSync(resolveRepositoryFile(target, quality.baseline, quality.baseline))
      ? resolveRepositoryFile(target, quality.baseline, quality.baseline)
      : null;
  const decisionsPath = resolveRepositoryFile(target, options.decisions, quality.decisions);
  const decisions = loadDecisionBundle(decisionsPath);
  let decisionWriteStatus = 'UNCHANGED';
  if (options.decision !== undefined) {
    const reviewedRevision = options['reviewed-revision'];
    const created = {
      findingId: options.finding || options['finding-id'],
      decision: String(options.decision).toUpperCase(),
      reason: options.reason,
      reviewer: options.reviewer,
      reviewedRevision,
      ...(options['review-after'] ? { reviewAfter: options['review-after'] } : {}),
      evidence: parseEvidence(options),
    };
    validateDecision(created);
    const known = [...(run.findings || [])];
    if (baselinePath && fs.existsSync(baselinePath)) known.push(...(readJson(baselinePath).findings || []));
    if (!known.some((finding) => finding.id === created.findingId)) throw new Error(`Finding ${created.findingId} is not present in the supplied run or baseline.`);
    const duplicate = decisions.decisions.some((existing) => JSON.stringify(existing) === JSON.stringify(created));
    if (!duplicate) {
      decisions.decisions.push(created);
      decisionWriteStatus = options.preview ? 'PREVIEW' : 'WRITTEN';
      if (!options.preview) writeJson(decisionsPath, decisions);
    }
  }

  let comparison;
  if (!baselinePath) {
    comparison = notEvaluatedComparison('No baseline artifact was supplied or configured.', run, quality.ratchet);
  } else if (!fs.existsSync(baselinePath)) {
    comparison = notEvaluatedComparison(`Baseline file does not exist: ${path.relative(target, baselinePath)}`, run, quality.ratchet);
  } else {
    const baseline = readJson(baselinePath);
    comparison = compareRuns(baseline, run, decisions, quality.ratchet);
  }
  if (comparison.status === 'NOT_EVALUATED') {
    comparison.staleDecisions = evaluateDecisionStaleness(decisions, run, null, comparison);
  }
  if (comparison.classifiedFindings) {
    run.findings = comparison.classifiedFindings;
    delete comparison.classifiedFindings;
  }
  const stale = comparison.staleDecisions || [];
  const status = comparison.status === 'NOT_EVALUATED'
    ? 'NOT_EVALUATED'
    : stale.some((item) => item.status === 'STALE')
      ? 'STALE_DECISIONS'
      : comparison.qualityGate.status;
  const result = {
    command: 'triage',
    status,
    findings: run.findings,
    decisions: stale,
    decisionFile: path.relative(target, decisionsPath).split(path.sep).join('/'),
    decisionWriteStatus,
    comparison,
    qualityGate: comparison.qualityGate,
  };
  const outputPath = options.output ? resolveRepositoryFile(target, options.output, 'triage-result.json') : null;
  const content = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
  if (['NOT_EVALUATED', 'STALE_DECISIONS', 'FAIL'].includes(status)) process.exitCode = 2;
}

function planContext(inputPath, options) {
  const resolvedInput = path.resolve(process.cwd(), inputPath);
  const run = readJson(resolvedInput);
  const target = findRepositoryRoot(options.repository || path.dirname(resolvedInput));
  const config = loadConfig(target);
  const quality = configuredQuality(target, config);
  const baselinePath = options.baseline !== undefined
    ? resolveRepositoryFile(target, options.baseline, quality.baseline)
    : fs.existsSync(resolveRepositoryFile(target, quality.baseline, quality.baseline))
      ? resolveRepositoryFile(target, quality.baseline, quality.baseline)
      : null;
  const decisionsPath = options.decisions !== undefined
    ? resolveRepositoryFile(target, options.decisions, quality.decisions)
    : fs.existsSync(resolveRepositoryFile(target, quality.decisions, quality.decisions))
      ? resolveRepositoryFile(target, quality.decisions, quality.decisions)
      : null;
  const decisions = loadDecisionBundle(decisionsPath);
  let enrichedRun = run;
  let staleDecisions = run.comparison?.staleDecisions || [];
  if (baselinePath && fs.existsSync(baselinePath)) {
    const comparison = compareRuns(readJson(baselinePath), run, decisions, quality.ratchet);
    const { classifiedFindings, ...serializableComparison } = comparison;
    enrichedRun = {
      ...run,
      ...(classifiedFindings ? { findings: classifiedFindings } : {}),
      comparison: serializableComparison,
      qualityGate: comparison.qualityGate,
    };
    staleDecisions = comparison.staleDecisions || [];
  } else if (decisionsPath) {
    staleDecisions = evaluateDecisionStaleness(decisions, run, null, run.comparison || null);
  }
  return { inputPath: resolvedInput, run: enrichedRun, decisions, staleDecisions, target, quality };
}

function planCommand(positional, options) {
  if (options.next) return planNextCommand(positional, options);
  if (options.export) {
    const exportInput = options.export === true ? positional[0] : options.export;
    return planExportCommand(options.export === true ? positional : [exportInput], options);
  }
  const input = positional[0] || options.run;
  if (!input) throw new Error('plan requires an audit run JSON path.');
  const context = planContext(input, options);
  const plan = buildPlan(context.run, { decisions: context.decisions, staleDecisions: context.staleDecisions });
  const outputPath = path.resolve(process.cwd(), options.output || 'quality-audit-kit.plan.json');
  const markdownPath = path.resolve(process.cwd(), options.markdown || outputPath.replace(/\.json$/i, '.md'));
  writeOutput(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  writeOutput(markdownPath, renderPlanMarkdown(plan));
  process.stdout.write(`${JSON.stringify({ command: 'plan', status: plan.status, planId: plan.planId, runId: plan.runId, output: path.relative(process.cwd(), outputPath).split(path.sep).join('/'), markdown: path.relative(process.cwd(), markdownPath).split(path.sep).join('/'), lotCount: plan.lots.length, excludedFindingCount: plan.excludedFindings.length }, null, 2)}\n`);
}

function loadPlanOrCreate(input, options) {
  const inputPath = path.resolve(process.cwd(), input || 'quality-audit-kit.plan.json');
  const value = readJson(inputPath);
  if (value && value.planType === 'QUALITY_CORRECTION_PLAN') return validatePlanStructure(value);
  const context = planContext(inputPath, options);
  return validatePlanStructure(buildPlan(context.run, { decisions: context.decisions, staleDecisions: context.staleDecisions }));
}

function planNextCommand(positional, options) {
  const plan = loadPlanOrCreate(positional[0] || options.plan, options);
  const next = nextLot(plan);
  const result = {
    command: 'plan --next',
    status: next.status,
    planId: plan.planId,
    runId: plan.runId,
    reason: next.reason,
    ...(next.lot ? { lot: next.lot, prompt: plan.prompts.find((prompt) => prompt.lotId === next.lot.id)?.content || null } : { lot: null, prompt: null }),
  };
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  const content = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
}

function planExportCommand(positional, options) {
  const plan = validatePlanStructure(loadPlanOrCreate(positional[0] || options.plan, options));
  const prepared = preparePromptExport(path.resolve(process.cwd(), options.output || 'quality-audit-kit-codex-prompts'), plan.prompts);
  const files = prepared.targets.map(({ prompt, target }) => {
    writeOutput(target, prompt.content);
    return path.relative(process.cwd(), target).split(path.sep).join('/');
  });
  process.stdout.write(`${JSON.stringify({ command: 'plan --export', status: 'EXPORTED', planId: plan.planId, runId: plan.runId, outputDirectory: path.relative(process.cwd(), prepared.lexicalRoot).split(path.sep).join('/'), files }, null, 2)}\n`);
}

async function fixCommand(positional, options) {
  if (!options.next) throw new Error('fix currently requires --next; it never selects an arbitrary lot implicitly.');
  const input = positional[0] || options.plan;
  const planPath = path.resolve(process.cwd(), input || 'quality-audit-kit.plan.json');
  const plan = loadPlanOrCreate(planPath, options);
  const next = nextLot(plan);
  const target = findRepositoryRoot(options.repository || path.dirname(planPath));
  const authorizedValidations = String(options['authorize-validation'] || options.validate || '').split(',').map((name) => name.trim()).filter(Boolean);
  const result = await executeFix({
    plan,
    next,
    root: target,
    agentName: options.agent || 'codex',
    agentOptions: { command: options['codex-command'] || options['agent-command'] },
    validationOptions: { authorizedNames: authorizedValidations },
    validate: (root) => runValidations(root, { authorizedNames: authorizedValidations }),
    execute: options.execute === true,
    approve: options.execute === true && options.approve === true,
  });
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  const content = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
  if (['FAILED', 'BLOCKED', 'UNVERIFIED', 'NEEDS_TRIAGE', 'NEEDS_REVIEW', 'BLOCKED_BY_MEASUREMENT'].includes(result.status)) process.exitCode = 2;
  return result;
}

function verifyCommand(positional, options) {
  const input = positional[0] || options.input;
  if (!input) throw new Error('verify requires a fix result JSON path.');
  const result = verifyFixResult(readJson(path.resolve(process.cwd(), input)));
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  const content = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
  if (result.status !== 'RESOLVED' || result.verified !== true) process.exitCode = 2;
  return result;
}

async function connectCommand(positional, options) {
  if (positional[0] !== 'sonar') throw new Error('connect currently supports only the sonar connector.');
  const result = await connectSonar({
    root: findRepositoryRoot(options.repository || process.cwd()),
    url: options['sonar-url'] || options.url || process.env.SONAR_URL,
    project: options['sonar-project'] || options.project || process.env.SONAR_PROJECT,
    tokenEnv: options['sonar-token-env'],
    tokenFile: options['sonar-token-file'],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function importCommand(positional, options) {
  if (positional[0] === 'sarif') {
    const target = findRepositoryRoot(options.repository || process.cwd());
    const input = options['sarif-report'] || options.input || positional[1];
    if (!input) throw new Error('import sarif requires a SARIF 2.1.0 file path.');
    const filePath = path.isAbsolute(String(input)) ? String(input) : path.resolve(process.cwd(), String(input));
    const discovery = discover(target);
    const result = importSarifFile(target, filePath);
    const run = {
      schemaVersion: '0.1-draft',
      runId: createRunId(),
      repository: { name: discovery.repositoryName, sourceScopeDescription: 'SARIF findings were imported from an explicitly selected local report; any Git context is not an analyzed source revision.' },
      inputScope: 'WORKTREE_LIVE',
      reproducible: false,
      generatedAt: new Date().toISOString(),
      discovery: discoveryForOutput(discovery),
      engines: [result.engine],
      findings: result.findings,
      ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
      connector: { name: 'sarif', projectKey: 'local-file', version: result.engine.version, sourceRevision: result.engine.sourceRevision },
    };
    const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
    const content = `${JSON.stringify(run, null, 2)}\n`;
    if (outputPath) writeOutput(outputPath, content);
    else process.stdout.write(content);
    if (result.engine.measurementStatus !== 'MEASURED') process.exitCode = 2;
    return run;
  }
  if (positional[0] !== 'sonar') throw new Error('import currently supports only the sarif and sonar connectors.');
  const target = findRepositoryRoot(options.repository || positional[1] || process.cwd());
  const discovery = discover(target);
  const result = await importSonar(target, {
    url: options['sonar-url'] || options.url || process.env.SONAR_URL,
    project: options['sonar-project'] || options.project || process.env.SONAR_PROJECT,
    branch: options['sonar-branch'] || options.branch,
    pullRequest: options['sonar-pull-request'] || options.pullRequest,
    revision: options['sonar-revision'] || options.revision,
    maxResults: options['sonar-max-results'] || options.maxResults,
    tokenEnv: options['sonar-token-env'],
    tokenFile: options['sonar-token-file'],
  });
  const contextCommitSha = gitCommit(target);
  const run = {
    schemaVersion: '0.1-draft',
    runId: createRunId(),
    repository: {
      name: discovery.repositoryName,
      ...(contextCommitSha ? { contextCommitSha, commitSha: contextCommitSha } : {}),
      sourceScopeDescription: 'SonarQube findings were imported from the declared project analysis. Any local Git SHA is context only; engine.sourceRevision is the SonarQube analysis revision.',
    },
    inputScope: 'WORKTREE_LIVE',
    reproducible: false,
    generatedAt: new Date().toISOString(),
    discovery: discoveryForOutput(discovery),
    engines: [result.engine],
    findings: result.findings,
    ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
    connector: { name: 'sonarqube', projectKey: result.project, ...(result.branch ? { branch: result.branch } : {}), version: result.version, sourceRevision: result.sourceRevision },
  };
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  const content = `${JSON.stringify(run, null, 2)}\n`;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
  if (result.status !== 'MEASURED') process.exitCode = 2;
  return run;
}

function reportCommand(positional, options) {
  if (options['verify-bundle'] !== undefined) {
    const bundlePath = options['verify-bundle'] === true ? positional[0] : options['verify-bundle'];
    if (!bundlePath) throw new Error('report --verify-bundle requires a ZIP path.');
    const verification = verifyBundle(path.resolve(process.cwd(), bundlePath));
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    return verification;
  }
  const inputPath = positional[0];
  if (!inputPath) throw new Error('report requires a run JSON path.');
  const resolvedInput = path.resolve(process.cwd(), inputPath);
  const run = readJson(resolvedInput);
  const format = options.format || 'terminal';
  if (!['terminal', 'markdown', 'json', 'sarif', 'zip'].includes(format)) throw new Error(`Unsupported report format: ${format}`);
  const bundlePath = options.bundle ? path.resolve(process.cwd(), options.bundle) : (format === 'zip' && options.output ? path.resolve(process.cwd(), options.output) : null);
  if (format === 'zip' && !bundlePath) throw new Error('report --format zip requires --bundle file.zip or --output file.zip.');
  if (bundlePath) createBundle(run, resolvedInput, bundlePath, options);
  if (format === 'zip') {
    process.stdout.write(`Offline bundle written: ${bundlePath}\n`);
    return;
  }
  const content = format === 'json'
    ? `${JSON.stringify(buildStructuredReport(run), null, 2)}\n`
    : format === 'sarif' ? `${JSON.stringify(buildSarif(run), null, 2)}\n`
    : format === 'markdown' ? renderMarkdown(run) : renderTerminal(run);
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
}

const THRESHOLD_DIMENSIONS = ['language', 'workspace', 'fileCategory', 'scope'];

function thresholdSeriesMatches(left, right) {
  const leftName = left?.name ?? left?.metric;
  const rightName = right?.metric ?? right?.name;
  if (!left || !right || leftName !== rightName || left.unit !== right.unit || left.direction !== right.direction) return false;
  return THRESHOLD_DIMENSIONS.every((dimension) => String(left[dimension] ?? 'UNKNOWN') === String(right[dimension] ?? 'UNKNOWN'));
}

function strictestThresholdValue(thresholds, direction) {
  const values = thresholds.map((threshold) => Number(threshold.value));
  return direction === 'HIGHER_IS_BETTER' ? Math.max(...values) : Math.min(...values);
}

function validateThresholdEntry(threshold, label) {
  const name = threshold?.name ?? threshold?.metric;
  if (!threshold || typeof threshold !== 'object' || Array.isArray(threshold) || typeof name !== 'string' || !name || typeof threshold.unit !== 'string' || !['LOWER_IS_BETTER', 'HIGHER_IS_BETTER'].includes(threshold.direction) || typeof threshold.value !== 'number' || !Number.isFinite(threshold.value) || threshold.value < 0) throw new Error(`${label} is invalid; no normative mutation was applied.`);
  for (const dimension of THRESHOLD_DIMENSIONS) if (threshold[dimension] !== undefined && typeof threshold[dimension] !== 'string') throw new Error(`${label} has an invalid ${dimension}; no normative mutation was applied.`);
}

function mergeApprovedThresholdConfig(config, result, proposal, profile) {
  const existingQuality = config.quality && typeof config.quality === 'object' && !Array.isArray(config.quality) ? config.quality : {};
  const existingThresholds = existingQuality.thresholds === undefined
    ? {}
    : existingQuality.thresholds && typeof existingQuality.thresholds === 'object' && !Array.isArray(existingQuality.thresholds)
      ? existingQuality.thresholds
      : (() => { throw new Error('Existing quality.thresholds configuration is invalid; no normative mutation was applied.'); })();
  const existingRatchet = existingThresholds.ratchet === undefined
    ? {}
    : existingThresholds.ratchet && typeof existingThresholds.ratchet === 'object' && !Array.isArray(existingThresholds.ratchet)
      ? existingThresholds.ratchet
      : (() => { throw new Error('Existing quality.thresholds.ratchet configuration is invalid; no normative mutation was applied.'); })();
  const existingMetrics = existingRatchet.metrics === undefined
    ? []
    : Array.isArray(existingRatchet.metrics)
      ? existingRatchet.metrics
      : (() => { throw new Error('Existing quality.thresholds.ratchet.metrics configuration is invalid; no normative mutation was applied.'); })();
  existingMetrics.forEach((threshold, index) => validateThresholdEntry(threshold, `Existing threshold ${index}`));
  const proposedMetrics = proposal.thresholds.map((threshold) => ({ ...threshold }));
  proposedMetrics.forEach((threshold, index) => validateThresholdEntry(threshold, `Proposed threshold ${index}`));
  for (const proposed of proposedMetrics) {
    const compatible = existingMetrics.filter((candidate) => thresholdSeriesMatches(candidate, proposed));
    if (!compatible.length) continue;
    const current = strictestThresholdValue(compatible, proposed.direction);
    const relaxes = proposed.direction === 'HIGHER_IS_BETTER' ? proposed.value < current : proposed.value > current;
    if (relaxes) throw new Error(`Refusing to relax approved threshold for ${proposed.metric} (${proposed.direction}); explicit policy review is required.`);
  }
  const seriesKey = (threshold) => JSON.stringify({ metric: threshold.metric ?? threshold.name, unit: threshold.unit, direction: threshold.direction, ...Object.fromEntries(THRESHOLD_DIMENSIONS.map((dimension) => [dimension, threshold[dimension] ?? 'UNKNOWN'])) });
  const concerned = new Set(proposedMetrics.map(seriesKey));
  const untouched = existingMetrics.filter((threshold) => !concerned.has(seriesKey(threshold)));
  return {
    ...config,
    quality: {
      ...existingQuality,
      thresholds: {
        ...existingThresholds,
        profile,
        ratchet: { ...existingRatchet, metrics: [...untouched, ...proposedMetrics], runId: result.runId },
        approval: { ...(existingThresholds.approval || {}), kind: 'EXPLICIT_CLI_APPROVAL', runId: result.runId },
      },
    },
  };
}

function thresholdsCommand(positional, options) {
  if (positional[0] !== 'recommend') throw new Error('thresholds requires the recommend subcommand.');
  const input = positional[1] || options.run;
  if (!input) throw new Error('thresholds recommend requires an audit run JSON path.');
  const resolvedInput = path.resolve(process.cwd(), input);
  const run = readJson(resolvedInput);
  const target = findRepositoryRoot(options.repository || path.dirname(resolvedInput));
  const config = loadConfig(target);
  const quality = configuredQuality(target, config);
  const baselinePath = options.baseline !== undefined
    ? resolveRepositoryFile(target, options.baseline, quality.baseline)
    : fs.existsSync(resolveRepositoryFile(target, quality.baseline, quality.baseline))
      ? resolveRepositoryFile(target, quality.baseline, quality.baseline)
      : null;
  const baseline = baselinePath && fs.existsSync(baselinePath) ? readJson(baselinePath) : null;
  const result = recommendThresholds(run, { baseline, config });
  const format = options.format || 'json';
  if (!['json', 'markdown'].includes(format)) throw new Error(`Unsupported thresholds format: ${format}`);
  const outputPath = options.output && options.output !== '-'
    ? path.resolve(process.cwd(), options.output)
    : null;
  const content = format === 'markdown'
    ? renderThresholdsMarkdown(result)
    : `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);

  if (options.export !== undefined) {
    const exportPath = path.resolve(process.cwd(), options.export === true ? 'quality-audit-kit.thresholds.proposed.json' : options.export);
    const profile = options.profile || 'balanced';
    if (!['progressive', 'balanced', 'strict'].includes(profile)) throw new Error(`Unsupported thresholds profile: ${profile}`);
    writeOutput(exportPath, `${JSON.stringify(buildThresholdConfig(result, profile), null, 2)}\n`);
  }

  if (options.apply) {
    if (!options.approve) throw new Error('thresholds --apply requires explicit --approve; recommendations and exports never mutate normative policy.');
    const profile = options.profile || 'balanced';
    if (!['progressive', 'balanced', 'strict'].includes(profile)) throw new Error(`Unsupported thresholds profile: ${profile}`);
    const unknownDirection = result.proposals.filter((proposal) => proposal.status === 'DIRECTION_UNKNOWN');
    if (unknownDirection.length) throw new Error('Cannot apply normative thresholds while one or more measured metric directions are unknown; provide an explicit validated direction first.');
    const invalidMeasurements = result.measurement.warnings.filter((warning) => warning.status === 'INVALID');
    if (invalidMeasurements.length) throw new Error('Cannot apply normative thresholds while one or more measurements are invalid; no normative mutation was applied.');
    const proposal = buildThresholdConfig(result, profile);
    if (!proposal.thresholds.length) throw new Error('No sufficiently measured threshold proposal is available for normative application.');
    const updated = mergeApprovedThresholdConfig(config, result, proposal, profile);
    writeJsonAtomicReplace(path.join(target, CONFIG_FILENAME), updated);
  }
  return result;
}

function printHelp() {
  process.stdout.write(`Quality Audit Kit ${require('../package.json').version} (experimental)\n\nUsage:\n  quality-audit-kit init [repository] [--force] [--templates deterministic|none] [--update-templates] [--preview]\n  quality-audit-kit init [repository] --agent codex [--agent-prompt file] [--agent-input file]\n  quality-audit-kit context refresh [repository] [--preview]\n  quality-audit-kit init [repository] --link-agents\n  quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--run[=knip,jscpd]] [--baseline file] [--decisions file]\n  quality-audit-kit baseline run.json [--output file] [--replace] [--preview]\n  quality-audit-kit triage run.json [--baseline file] [--decisions file] [--finding id --decision FIX|DEFER|KEEP_JUSTIFIED|FALSE_POSITIVE --reason text --reviewer name --reviewed-revision sha --evidence TYPE|REFERENCE|OUTCOME]\n  quality-audit-kit report run.json [--format markdown|json] [--output file]\n\ninit creates protected generic PROJECT_HANDOFF.md and COMMIT_REVIEW.md templates. Existing documents are never overwritten by default; --update-templates refreshes only managed generated blocks and preserves manual sections. --preview emits deterministic diff previews without mutation.\ncontext refresh updates only detected facts and controls, reports changed values and contradictions, and preserves all instructions and manual decisions.\n--agent codex prepares a Codex customization request; it does not execute an agent or contact a service unless explicit input is supplied with --agent-input.\nscan imports existing JSON reports by default. --run explicitly executes installed local scanners; it never installs dependencies. With --baseline it compares only complete, compatible measurements and applies the configured ratchet.\nbaseline creates an explicit, versioned baseline; replacing one requires --replace and never increases a configured ceiling automatically. triage appends an evidence-backed decision or reports stale decisions.\nNo scanner, failed scanner, incomplete audit, or unmeasured scanner is treated as a clean result.\n`);
}

function printHelpDetailed() {
  process.stdout.write(`Quality Audit Kit ${require('../package.json').version} (experimental)\n\nUsage:\n  quality-audit-kit init [repository] [--force] [--templates deterministic|none] [--update-templates] [--preview]\n  quality-audit-kit init [repository] --agent codex [--agent-prompt file] [--agent-input file]\n  quality-audit-kit context refresh [repository] [--preview]\n  quality-audit-kit init [repository] --link-agents\n  quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--run[=knip,jscpd]] [--baseline file] [--decisions file]\n  quality-audit-kit baseline run.json [--output file] [--replace] [--preview]\n  quality-audit-kit triage run.json [--baseline file] [--decisions file] [--finding id --decision FIX|DEFER|KEEP_JUSTIFIED|FALSE_POSITIVE --reason text --reviewer name --reviewed-revision sha --evidence TYPE|REFERENCE|OUTCOME]\n  quality-audit-kit report run.json [--format terminal|markdown|json] [--output file] [--bundle file.zip] [--include-evidence file[,file...]]\n  quality-audit-kit report --verify-bundle file.zip\n\nreport defaults to a readable terminal summary. Markdown and structured JSON are deterministic derived views. --bundle creates an offline ZIP with manifest, inventory, checksums and verification instructions. Existing output artifacts are never overwritten; source files, secrets and absolute paths are not bundled.\nNo scanner, failed scanner, incomplete audit, or unmeasured scanner is treated as a clean result.\n`);
}

function printPlanHelp() {
  process.stdout.write('\nPlan usage:\n  quality-audit-kit plan run.json [--output plan.json] [--markdown plan.md] [--baseline file] [--decisions file]\n  quality-audit-kit plan --next [plan.json] [--output next.json]\n  quality-audit-kit plan --export plan.json [--output prompts-directory]\n\nplan creates deterministic correction lots and autonomous Codex prompts. Grouping requires explicit common-cause evidence; uncertain findings, stale decisions, missing measurements and dependency cycles remain visible and block silent correction claims.\n');
}

function printThresholdsHelp() {
  process.stdout.write('\nThresholds usage:\n  quality-audit-kit thresholds recommend run.json [--baseline file] [--format json|markdown] [--output file] [--export config.json] [--profile progressive|balanced|strict]\n  quality-audit-kit thresholds recommend run.json --apply --approve [--profile progressive|balanced|strict]\n\nthresholds recommend is a local advisory analysis. It reports distributions, quantiles, extremes, exceedances and three explainable profiles by metric, language, workspace and file category. Generated files, unavailable scanners, failed measurements and insufficient samples do not become zero findings. --export writes a proposal; only --apply --approve can modify normative thresholds.\n');
}

function printFixHelp() {
  process.stdout.write('\nFix and verify usage:\n  quality-audit-kit fix --next [plan.json] [--output fix-result.json]\n  quality-audit-kit fix --next [plan.json] --execute --approve [--agent codex|command|deterministic] [--codex-command executable] [--authorize-validation name[,name]]\n  quality-audit-kit verify fix-result.json [--output verification.json]\n\nfix --next is read-only by default and presents the next bounded lot. Agent execution requires both --execute and --approve. Only an adapter declaring strong physical confinement may execute; the built-in Codex and command adapters are refused without such a mechanism. The agent receives a physical no-symlink allowlist; commits, pushes, deletions, baseline changes, policy changes and writes outside the allowlist are prohibited and audited. Validation scripts are never trusted by name: each must be explicitly authorized and declared in package.json. verify checks only the redacted execution evidence and never runs an agent.\n');
}

function printConnectorHelp() {
  process.stdout.write('\nConnector usage:\n  quality-audit-kit scan [repository] --sarif-report report.sarif\n  quality-audit-kit import sarif report.sarif [--repository repository] [--output run.json]\n  quality-audit-kit report run.json --format sarif --output report.sarif\n  quality-audit-kit connect sonar --sonar-url URL [--sonar-token-env NAME|--sonar-token-file FILE]\n  quality-audit-kit import sonar [repository] --sonar-url URL --sonar-project KEY [--sonar-branch NAME|--sonar-pull-request KEY] [--sonar-max-results N] [--output run.json]\n\nSARIF is local and requires no account. SonarQube uses official API endpoints, keeps tokens outside repository artifacts, paginates with a bounded result limit and records Sonar analysis revision separately from local Git context.\n');
}

async function main(argv) {
  const { command, options, positional } = parseArguments(argv);
  if (options.help || command === 'help' || command === '--help') { printHelpDetailed(); printPlanHelp(); printThresholdsHelp(); printFixHelp(); printConnectorHelp(); return; }
  if (options.version || command === '--version') return process.stdout.write(`${require('../package.json').version}\n`);
  if (command === 'init') return initCommand(positional, options);
  if (command === 'context') {
    if (positional[0] !== 'refresh') throw new Error('context requires the refresh subcommand.');
    return contextRefreshCommand(positional.slice(1), options);
  }
  if (command === 'scan') return scanCommand(positional, options);
  if (command === 'baseline') return baselineCommand(positional, options);
  if (command === 'triage') return triageCommand(positional, options);
  if (command === 'plan') return planCommand(positional, options);
  if (command === 'fix') return fixCommand(positional, options);
  if (command === 'verify') return verifyCommand(positional, options);
  if (command === 'connect') return connectCommand(positional, options);
  if (command === 'import') return importCommand(positional, options);
  if (command === 'report') return reportCommand(positional, options);
  if (command === 'thresholds') return thresholdsCommand(positional, options);
  throw new Error(`Unknown command: ${command}. Use --help for usage.`);
}

module.exports = { main, parseArguments, scannerSelection };
