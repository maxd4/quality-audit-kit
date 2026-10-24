const fs = require('node:fs');
const path = require('node:path');

const { normalizeSarif } = require('./normalize');

const SARIF_VERSION = '2.1.0';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

function readSarif(filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`SARIF report could not be read: ${error.message}`);
  }
  if (!value || value.version !== SARIF_VERSION || !Array.isArray(value.runs)) throw new Error('SARIF report must conform to version 2.1.0 and contain runs.');
  return value;
}

function importSarifFile(root, filePath) {
  const log = readSarif(filePath);
  const relative = path.relative(root, filePath).split(path.sep).join('/') || path.basename(filePath);
  const normalized = normalizeSarif(root, log, { kind: 'REPORT', reference: relative, engine: 'sarif' });
  if (log.runs.length === 0) normalized.diagnostics.push({ kind: 'SARIF_DIAGNOSTIC', code: 'NO_RUNS', reference: 'sarif://runs', message: 'SARIF contains no analysis runs; no clean result is inferred.' });
  const engines = [];
  for (const [index, run] of log.runs.entries()) {
    const driver = run?.tool?.driver || {};
    const name = String(driver.name || driver.guid || `sarif-run-${index + 1}`);
    const revision = run?.versionControlProvenance?.[0]?.revisionId;
    engines.push({
      name: `sarif:${name}`,
      version: String(driver.version || driver.semanticVersion || 'UNKNOWN'),
      measurementStatus: run?.results === null ? 'FAILURE' : run?.results === undefined ? 'PARTIAL' : 'MEASURED',
      gateOutcome: run?.results === null || run?.results === undefined ? 'NOT_EVALUATED' : 'INFORMATIVE',
      scope: '.',
      sourceRevision: /^[a-f0-9]{40}$/i.test(String(revision || ''))
        ? { status: 'UNVERIFIED', sha: String(revision).toLowerCase(), basis: 'SARIF declared revisionId; imported SARIF is not proof that the local repository content matches it.' }
        : { status: 'UNKNOWN', sha: null, basis: 'Imported SARIF did not provide a demonstrable source revision.' },
    });
  }
  // A single canonical engine keeps the contract stable even when a SARIF log contains multiple runs.
  const sourceKeys = new Set(engines.map((engine) => `${engine.sourceRevision.status}:${engine.sourceRevision.sha || ''}`));
  const sourceRevision = sourceKeys.size === 1
    ? (engines[0]?.sourceRevision || { status: 'UNKNOWN', sha: null, basis: 'SARIF contained no analysis runs.' })
    : { status: 'UNKNOWN', sha: null, basis: 'SARIF contained multiple runs with different source revisions; no single revision was assigned to the aggregate measurement.' };
  if (sourceKeys.size > 1) normalized.diagnostics.push({ kind: 'SARIF_DIAGNOSTIC', code: 'MIXED_SOURCE_REVISIONS', reference: 'sarif://runs', message: 'SARIF runs declared different source revisions; the aggregate measurement remains UNKNOWN.' });
  return {
    findings: normalized.findings.map((finding) => ({ ...finding, provenance: { ...finding.provenance, sourceRevision } })),
    diagnostics: normalized.diagnostics,
    engine: {
      name: 'sarif',
      version: engines.map((engine) => engine.version).filter((version) => version !== 'UNKNOWN').join(', ') || 'UNKNOWN',
      measurementStatus: !engines.length ? 'NOT_MEASURED' : engines.some((engine) => engine.measurementStatus === 'FAILURE') ? 'FAILURE' : engines.some((engine) => engine.measurementStatus === 'PARTIAL') ? 'PARTIAL' : 'MEASURED',
      gateOutcome: !engines.length || engines.some((engine) => ['FAILURE', 'PARTIAL'].includes(engine.measurementStatus)) ? 'NOT_EVALUATED' : 'INFORMATIVE',
      scope: '.',
      sourceRevision,
      diagnostic: normalized.diagnostics.length ? `${normalized.diagnostics.length} SARIF diagnostic(s) were retained separately from canonical findings.` : undefined,
    },
  };
}

function redact(value) {
  return String(value || '')
    .replace(/\b(?:ghp_|github_pat_|sk-|rk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[REDACTED_SECRET]');
}

function sarifLevel(severity) {
  return { CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'note', INFO: 'note' }[severity] || 'none';
}

function buildSarif(run) {
  const engineNames = [...new Set((run.findings || []).map((finding) => finding.engine))];
  const engines = run.engines || [];
  const groups = engineNames.length ? engineNames : engines.map((engine) => engine.name);
  const runs = groups.map((engineName) => {
    const engine = engines.find((candidate) => candidate.name === engineName) || {};
    const findings = (run.findings || []).filter((finding) => finding.engine === engineName);
    const resultList = findings.map((finding) => ({
      ruleId: redact(finding.ruleId),
      level: sarifLevel(finding.severity),
      message: { text: redact(finding.message) },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: redact(finding.path), uriBaseId: 'SRCROOT' },
        ...(finding.line ? { region: { startLine: finding.line } } : {}),
      } }],
      properties: {
        qakFindingId: redact(finding.id),
        qakLifecycle: finding.lifecycle,
        qakMeasurementStatus: finding.measurementStatus,
        qakProvenance: redact(JSON.stringify(finding.provenance || {})),
        ...(finding.rawReference ? { qakRawReference: redact(finding.rawReference) } : {}),
      },
    }));
    const diagnostics = run.diagnostics || [];
    return {
      tool: { driver: { name: redact(engineName), version: redact(engine.version || 'UNKNOWN') } },
      results: resultList,
      properties: {
        qakRunId: redact(run.runId),
        qakContextCommitSha: redact(run.repository?.contextCommitSha || run.repository?.commitSha || 'UNKNOWN'),
        qakSourceRevision: engine.sourceRevision || { status: 'UNKNOWN', sha: null },
        ...(diagnostics.length ? { qakDiagnostics: diagnostics.map((item) => ({ ...item, message: redact(item.message) })) } : {}),
      },
    };
  });
  if (!runs.length) runs.push({ tool: { driver: { name: 'quality-audit-kit', version: '0.1.0' } }, results: [] });
  return { version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs };
}

module.exports = { SARIF_SCHEMA, SARIF_VERSION, buildSarif, importSarifFile, readSarif };
