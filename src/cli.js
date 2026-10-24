const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { discover, findRepositoryRoot, resolveLocalBinary } = require('./discovery');
const { loadOrRunScanner } = require('./scanners');
const { renderMarkdown, writeOutput } = require('./report');

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
    if (next && !next.startsWith('--') && !['help', 'force'].includes(name)) {
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
  };
}

async function scanCommand(positional, options) {
  const target = findRepositoryRoot(positional[0] || process.cwd());
  const discovery = discover(target);
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
    });
    const engine = {
      name: scanner,
      measurementStatus: result.status,
      gateOutcome: result.gateOutcome,
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
      commitSha: gitCommit(target),
      sourceScopeDescription: 'Live repository workspace inspected without modifying source files.',
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

function initCommand(positional, options) {
  const target = findRepositoryRoot(positional[0] || process.cwd());
  const configPath = path.join(target, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !options.force) {
    throw new Error(`${CONFIG_FILENAME} already exists; pass --force to replace it.`);
  }
  const discovery = discover(target);
  writeJson(configPath, {
    version: '0.1-draft',
    outputDirectory: 'quality-audit-kit',
    scanners: {
      knip: { report: 'knip-report.json' },
      jscpd: { report: 'jscpd-report.json' },
    },
  });
  process.stdout.write(`${JSON.stringify({
    command: 'init',
    config: CONFIG_FILENAME,
    repository: discovery.repositoryName,
    packageManager: discovery.packageManager,
    workspaces: discovery.workspaces,
    scanners: discovery.scanners,
  }, null, 2)}\n`);
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
  process.stdout.write(`Quality Audit Kit ${require('../package.json').version} (experimental)\n\nUsage:\n  quality-audit-kit init [repository] [--force]\n  quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--run[=knip,jscpd]]\n  quality-audit-kit report run.json [--format markdown|json] [--output file]\n\nscan imports existing JSON reports by default. --run explicitly executes installed local scanners; it never installs dependencies.\nNo scanner, failed scanner, or unmeasured scanner is treated as a clean result.\n`);
}

async function main(argv) {
  const { command, options, positional } = parseArguments(argv);
  if (options.help || command === 'help' || command === '--help') return printHelp();
  if (options.version || command === '--version') return process.stdout.write(`${require('../package.json').version}\n`);
  if (command === 'init') return initCommand(positional, options);
  if (command === 'scan') return scanCommand(positional, options);
  if (command === 'report') return reportCommand(positional, options);
  throw new Error(`Unknown command: ${command}. Use --help for usage.`);
}

module.exports = { main, parseArguments, scannerSelection };
