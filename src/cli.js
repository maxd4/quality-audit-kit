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
    if (next && !next.startsWith('--') && !['help', 'force', 'preview', 'update-templates', 'link-agents', 'replace', 'next', 'apply', 'approve'].includes(name)) {
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
  if (engines.some((engine) => engine.measurementStatus === 'FAILURE')
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
  if (value.planType === 'QUALITY_CORRECTION_PLAN' && Array.isArray(value.lots)) return value;
  const context = planContext(inputPath, options);
  return buildPlan(context.run, { decisions: context.decisions, staleDecisions: context.staleDecisions });
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
  const plan = loadPlanOrCreate(positional[0] || options.plan, options);
  const outputDirectory = path.resolve(process.cwd(), options.output || 'quality-audit-kit-codex-prompts');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const files = [];
  for (const prompt of plan.prompts || []) {
    const outputPath = path.join(outputDirectory, prompt.fileName);
    writeOutput(outputPath, prompt.content);
    files.push(path.relative(process.cwd(), outputPath).split(path.sep).join('/'));
  }
  process.stdout.write(`${JSON.stringify({ command: 'plan --export', status: 'EXPORTED', planId: plan.planId, runId: plan.runId, outputDirectory: path.relative(process.cwd(), outputDirectory).split(path.sep).join('/'), files }, null, 2)}\n`);
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
  if (!['terminal', 'markdown', 'json', 'zip'].includes(format)) throw new Error(`Unsupported report format: ${format}`);
  const bundlePath = options.bundle ? path.resolve(process.cwd(), options.bundle) : (format === 'zip' && options.output ? path.resolve(process.cwd(), options.output) : null);
  if (format === 'zip' && !bundlePath) throw new Error('report --format zip requires --bundle file.zip or --output file.zip.');
  if (bundlePath) createBundle(run, resolvedInput, bundlePath, options);
  if (format === 'zip') {
    process.stdout.write(`Offline bundle written: ${bundlePath}\n`);
    return;
  }
  const content = format === 'json'
    ? `${JSON.stringify(buildStructuredReport(run), null, 2)}\n`
    : format === 'markdown' ? renderMarkdown(run) : renderTerminal(run);
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
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
    const proposal = buildThresholdConfig(result, profile);
    if (!proposal.thresholds.length) throw new Error('No sufficiently measured threshold proposal is available for normative application.');
    const updated = { ...config, quality: { ...(config.quality || {}), thresholds: {
      profile,
      ratchet: { metrics: proposal.thresholds, runId: result.runId },
      approval: { kind: 'EXPLICIT_CLI_APPROVAL', runId: result.runId },
    } } };
    writeJson(path.join(target, CONFIG_FILENAME), updated);
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

async function main(argv) {
  const { command, options, positional } = parseArguments(argv);
  if (options.help || command === 'help' || command === '--help') { printHelpDetailed(); printPlanHelp(); printThresholdsHelp(); return; }
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
  if (command === 'report') return reportCommand(positional, options);
  if (command === 'thresholds') return thresholdsCommand(positional, options);
  throw new Error(`Unknown command: ${command}. Use --help for usage.`);
}

module.exports = { main, parseArguments, scannerSelection };
