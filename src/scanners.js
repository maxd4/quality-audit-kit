const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { resolveLocalBinary, relativePath } = require('./discovery');
const { normalizeJscpd, normalizeKnip } = require('./normalize');

const REPORT_CANDIDATES = {
  knip: ['knip-report.json', '.knip-report.json', 'reports/knip.json', 'reports/knip-report.json'],
  jscpd: ['jscpd-report.json', 'reports/jscpd-report.json', 'reports/jscpd.json'],
};

// Knip and jscpd use exit 1 to indicate a findings/threshold result. Other
// non-zero codes are execution failures and must not be normalized as a full
// measurement, even when a partial JSON payload was emitted.
const EXPECTED_FINDING_EXIT_CODES = {
  knip: new Set([0, 1]),
  jscpd: new Set([0, 1]),
};

function affectsMeasurement(diagnostic) {
  return diagnostic?.measurementImpact !== 'NONE';
}

function measurementDiagnostics(diagnostics) {
  return diagnostics.filter(affectsMeasurement);
}

function unknownSourceRevision(basis) {
  return { status: 'UNKNOWN', sha: null, basis };
}

function resolveReportPath(root, explicitPath, scanner) {
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(root, explicitPath);
  }
  return REPORT_CANDIDATES[scanner]
    .map((candidate) => path.join(root, candidate))
    .find((candidate) => fs.existsSync(candidate)) || null;
}

function execute(command, args, cwd) {
  return new Promise((resolve) => {
    const windowsCommand = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
    if (windowsCommand && [command, ...args].some((value) => /[&|<>^%!"\r\n]/.test(String(value)))) {
      resolve({ error: new Error('refusing a local scanner path containing shell metacharacters'), stdout: '', stderr: '', exitCode: null });
      return;
    }
    const child = windowsCommand
      ? spawn([command, ...args].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(' '), { cwd, shell: true, windowsHide: true })
      : spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ error, stdout, stderr, exitCode: null }));
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

function parseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = Math.min(...[trimmed.indexOf('{'), trimmed.indexOf('[')].filter((index) => index >= 0));
    if (!Number.isFinite(start)) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function runArguments(scanner, outputDirectory) {
  if (scanner === 'knip') return ['--reporter', 'json'];
  return ['--reporters', 'json', '--output', outputDirectory, '.'];
}

async function loadOrRunScanner({ root, scanner, explicitReport, executeScanner, binary, executionSourceRevision }) {
  if (!executeScanner) {
    const reportPath = resolveReportPath(root, explicitReport, scanner);
    if (!reportPath) {
      return {
        status: 'NOT_MEASURED',
        gateOutcome: 'NOT_EVALUATED',
        sourceRevision: unknownSourceRevision('No scanner measurement was produced.'),
        diagnostic: binary
          ? `${scanner} is installed but was not executed; pass --run ${scanner} to request execution.`
          : `No ${scanner} report or local executable was found; install it explicitly or provide --${scanner}-report.`,
      };
    }
    if (!fs.existsSync(reportPath)) {
      return {
        status: explicitReport ? 'FAILURE' : 'NOT_MEASURED',
        gateOutcome: 'NOT_EVALUATED',
        sourceRevision: unknownSourceRevision('The report path did not produce a demonstrable source revision.'),
        diagnostic: explicitReport
          ? `${scanner} report was explicitly requested but does not exist: ${relativePath(root, reportPath)}`
          : `Configured ${scanner} report does not exist; no measurement was available.`,
      };
    }
    return readAndNormalize(root, scanner, reportPath, 'REPORT', unknownSourceRevision('Imported report does not identify the revision it analyzed.'));
  }

  if (!binary) {
    return {
      status: 'NOT_MEASURED',
      gateOutcome: 'NOT_EVALUATED',
      sourceRevision: unknownSourceRevision('The requested scanner is not installed locally.'),
      diagnostic: `--run requested ${scanner}, but no local ${scanner} executable was found; no dependency was installed.`,
    };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `quality-audit-kit-${scanner}-`));
  try {
    const result = await execute(binary, runArguments(scanner, temporaryDirectory), root);
    const reportPath = scanner === 'jscpd'
      ? path.join(temporaryDirectory, 'jscpd-report.json')
      : null;
    const parsed = parseJson(result.stdout) || (reportPath && fs.existsSync(reportPath) ? parseJson(fs.readFileSync(reportPath, 'utf8')) : null);
    if (!parsed) {
      return {
        status: 'FAILURE',
        gateOutcome: 'NOT_EVALUATED',
        sourceRevision: executionSourceRevision || unknownSourceRevision('Scanner execution did not produce a readable report.'),
        diagnostic: `${scanner} execution did not produce a readable JSON report${result.exitCode === null ? `: ${result.error?.message || 'process error'}` : ` (exit ${result.exitCode})`}. ${result.stderr.trim()}`.trim(),
      };
    }
    const sourceRevision = executionSourceRevision || unknownSourceRevision('Execution source revision was not provided by the runner.');
    if (!EXPECTED_FINDING_EXIT_CODES[scanner].has(result.exitCode)) {
      return {
        status: 'FAILURE',
        gateOutcome: 'NOT_EVALUATED',
        sourceRevision,
        diagnostic: `${scanner} exited with ${result.exitCode}; the JSON output was not accepted as a complete measurement. ${result.stderr.trim()}`.trim(),
      };
    }
    const provenance = { kind: 'EXECUTION', reference: `${scanner} -- ${runArguments(scanner, '<temporary-output>').join(' ')}`, sourceRevision };
    const normalized = scanner === 'knip'
      ? normalizeKnip(root, parsed, provenance)
      : normalizeJscpd(root, parsed, provenance);
    const findings = Array.isArray(normalized) ? normalized : normalized.findings;
    const diagnostics = Array.isArray(normalized?.diagnostics) ? normalized.diagnostics : [];
    const blockingDiagnostics = measurementDiagnostics(diagnostics);
    return {
      status: blockingDiagnostics.length ? 'PARTIAL' : 'MEASURED',
      gateOutcome: blockingDiagnostics.length ? 'NOT_EVALUATED' : 'INFORMATIVE',
      sourceRevision,
      ...(result.exitCode !== 0 ? { diagnostic: `${scanner} exited with expected findings code ${result.exitCode}; JSON report was normalized.` } : {}),
      ...(diagnostics.length ? { diagnostic: `${scanner} report was normalized with ${diagnostics.length} diagnostic(s)${blockingDiagnostics.length ? `, including ${blockingDiagnostics.length} completeness diagnostic(s)` : '; all are informative transformations'}.` } : {}),
      diagnostics,
      findings,
    };
  } catch (error) {
    return { status: 'FAILURE', gateOutcome: 'NOT_EVALUATED', sourceRevision: executionSourceRevision || unknownSourceRevision('Scanner report normalization failed.'), diagnostic: `${scanner} report normalization failed: ${error.message}` };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readAndNormalize(root, scanner, reportPath, sourceKind, sourceRevision) {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const provenance = { kind: sourceKind, reference: relativePath(root, reportPath), sourceRevision };
    const normalized = scanner === 'knip'
      ? normalizeKnip(root, parsed, provenance)
      : normalizeJscpd(root, parsed, provenance);
    const findings = Array.isArray(normalized) ? normalized : normalized.findings;
    const diagnostics = Array.isArray(normalized?.diagnostics) ? normalized.diagnostics : [];
    const blockingDiagnostics = measurementDiagnostics(diagnostics);
    return {
      status: blockingDiagnostics.length ? 'PARTIAL' : 'MEASURED',
      gateOutcome: blockingDiagnostics.length ? 'NOT_EVALUATED' : 'INFORMATIVE',
      sourceRevision,
      ...(diagnostics.length ? { diagnostic: `${scanner} report was normalized with ${diagnostics.length} diagnostic(s)${blockingDiagnostics.length ? `, including ${blockingDiagnostics.length} completeness diagnostic(s)` : '; all are informative transformations'}.` } : {}),
      diagnostics,
      findings,
    };
  } catch (error) {
    return {
      status: 'FAILURE',
      gateOutcome: 'NOT_EVALUATED',
      sourceRevision,
      diagnostic: `${scanner} report could not be normalized: ${error.message}`,
    };
  }
}

module.exports = {
  EXPECTED_FINDING_EXIT_CODES,
  REPORT_CANDIDATES,
  loadOrRunScanner,
  parseJson,
};
