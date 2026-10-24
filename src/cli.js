const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { discover, findRepositoryRoot, resolveLocalBinary } = require('./discovery');
const { loadOrRunScanner } = require('./scanners');
const { renderMarkdown, writeOutput } = require('./report');
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
    if (next && !next.startsWith('--') && !['help', 'force', 'preview', 'update-templates', 'link-agents'].includes(name)) {
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

  const content = `${JSON.stringify(run, null, 2)}\n`;
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
  if (engines.some((engine) => engine.measurementStatus === 'FAILURE')) process.exitCode = 2;
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

function reportCommand(positional, options) {
  const inputPath = positional[0];
  if (!inputPath) throw new Error('report requires a run JSON path.');
  const run = readJson(path.resolve(process.cwd(), inputPath));
  const format = options.format || 'markdown';
  if (!['json', 'markdown'].includes(format)) throw new Error(`Unsupported report format: ${format}`);
  const content = format === 'json' ? `${JSON.stringify(run, null, 2)}\n` : renderMarkdown(run);
  const outputPath = options.output && options.output !== '-' ? path.resolve(process.cwd(), options.output) : null;
  if (outputPath) writeOutput(outputPath, content);
  else process.stdout.write(content);
}

function printHelp() {
  process.stdout.write(`Quality Audit Kit ${require('../package.json').version} (experimental)\n\nUsage:\n  quality-audit-kit init [repository] [--force] [--templates deterministic|none] [--update-templates] [--preview]\n  quality-audit-kit init [repository] --agent codex [--agent-prompt file] [--agent-input file]\n  quality-audit-kit context refresh [repository] [--preview]\n  quality-audit-kit init [repository] --link-agents\n  quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--run[=knip,jscpd]]\n  quality-audit-kit report run.json [--format markdown|json] [--output file]\n\ninit creates protected generic PROJECT_HANDOFF.md and COMMIT_REVIEW.md templates. Existing documents are never overwritten by default; --update-templates refreshes only managed generated blocks and preserves manual sections. --preview emits deterministic diff previews without mutation.\ncontext refresh updates only detected facts and controls, reports changed values and contradictions, and preserves all instructions and manual decisions.\n--agent codex prepares a Codex customization request; it does not execute an agent or contact a service unless explicit input is supplied with --agent-input.\nscan imports existing JSON reports by default. --run explicitly executes installed local scanners; it never installs dependencies.\nNo scanner, failed scanner, or unmeasured scanner is treated as a clean result.\n`);
}

async function main(argv) {
  const { command, options, positional } = parseArguments(argv);
  if (options.help || command === 'help' || command === '--help') return printHelp();
  if (options.version || command === '--version') return process.stdout.write(`${require('../package.json').version}\n`);
  if (command === 'init') return initCommand(positional, options);
  if (command === 'context') {
    if (positional[0] !== 'refresh') throw new Error('context requires the refresh subcommand.');
    return contextRefreshCommand(positional.slice(1), options);
  }
  if (command === 'scan') return scanCommand(positional, options);
  if (command === 'report') return reportCommand(positional, options);
  throw new Error(`Unknown command: ${command}. Use --help for usage.`);
}

module.exports = { main, parseArguments, scannerSelection };
