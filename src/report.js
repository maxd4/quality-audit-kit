const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { buildCloneAudit, renderCloneMarkdown } = require('./clone-triage');
const { renderMaintainabilityTrendsMarkdown, renderMaintainabilityTrendsTerminal } = require('./trends');

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MEASUREMENT_STATUSES = new Set(['MEASURED', 'PARTIAL', 'NOT_MEASURED', 'FAILURE', 'SKIPPED_BY_POLICY']);
const SOURCE_STATUSES = new Set(['VERIFIED', 'UNVERIFIED', 'UNKNOWN']);
const SAFE_EVIDENCE_EXTENSIONS = new Set(['.json', '.md', '.txt', '.log', '.sarif', '.xml']);
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.mjs', '.php', '.py', '.rb', '.rs',
  '.sh', '.swift', '.ts', '.tsx', '.vue', '.html', '.css', '.scss', '.sql', '.env', '.pem', '.key',
  '.p12', '.pfx', '.sqlite', '.db',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeString(value) {
  let text = String(value);
  text = text.replace(/\b(?:ghp_|github_pat_|sk-|rk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED_TOKEN]');
  text = text.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s,"']+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED_SECRET]`);
  text = text.replace(/(?:[A-Za-z]:[\\/][^\r\n"'`<>|;]*|\\\\[^\r\n"'`<>|;]+)/g, '[REDACTED_PATH]');
  text = text.replace(/(^|[\s"'(=:])\/(?:[^\/\s"'`<>|]+\/)+[^\/\s"'`<>|]+/g, '$1[REDACTED_PATH]');
  return text;
}

function sanitizeForExport(value) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeForExport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForExport(item)]));
  return value;
}

function sourceRevisionOf(engine) {
  const sourceRevision = engine?.sourceRevision || { status: 'UNKNOWN', sha: null, basis: 'No source revision evidence was recorded.' };
  return {
    status: SOURCE_STATUSES.has(sourceRevision.status) ? sourceRevision.status : 'UNKNOWN',
    sha: SHA_PATTERN.test(String(sourceRevision.sha || '')) ? String(sourceRevision.sha).toLowerCase() : null,
    basis: String(sourceRevision.basis || 'No source revision evidence was recorded.'),
  };
}

function validateFunctionMeasurements(run) {
  if (run.functionMeasurements === undefined) return;
  if (!Array.isArray(run.functionMeasurements)) throw new Error('Report functionMeasurements must be an array when present.');
  const ids = new Set();
  for (const measurement of run.functionMeasurements) {
    if (!measurement || typeof measurement !== 'object' || !measurement.measurementId || ids.has(measurement.measurementId)) throw new Error('Report contains a missing or duplicate function measurement ID.');
    ids.add(measurement.measurementId);
    for (const field of ['engine', 'engineVersion', 'metricId', 'metricVersion', 'language', 'path', 'functionId', 'functionName', 'astRole', 'unit', 'direction', 'status', 'evidenceRef']) {
      if (typeof measurement[field] !== 'string' || !measurement[field]) throw new Error(`Function measurement is missing ${field}.`);
    }
    if (!Number.isFinite(measurement.value) || measurement.value < 0) throw new Error(`Function measurement ${measurement.measurementId} has an invalid value.`);
    if (!Number.isInteger(measurement.startLine) || measurement.startLine < 1 || !Number.isInteger(measurement.endLine) || measurement.endLine < measurement.startLine) throw new Error(`Function measurement ${measurement.measurementId} has invalid function lines.`);
    if (measurement.status !== 'MEASURED') throw new Error(`Function measurement ${measurement.measurementId} is not MEASURED.`);
    for (const field of ['subtreeStartLine', 'subtreeEndLine']) {
      if (measurement[field] !== undefined && measurement[field] !== null && (!Number.isInteger(measurement[field]) || measurement[field] < 1)) throw new Error(`Function measurement ${measurement.measurementId} has an invalid ${field}.`);
    }
    if (measurement.subtreeStartLine !== undefined && measurement.subtreeEndLine !== undefined
      && measurement.subtreeStartLine !== null && measurement.subtreeEndLine !== null
      && measurement.subtreeEndLine < measurement.subtreeStartLine) throw new Error(`Function measurement ${measurement.measurementId} has an invalid subtree interval.`);
    if (!measurement.provenance || typeof measurement.provenance !== 'object') throw new Error(`Function measurement ${measurement.measurementId} has no provenance.`);
    const source = sourceRevisionOf(measurement.provenance);
    if (source.status === 'VERIFIED' && !source.sha) throw new Error(`Function measurement ${measurement.measurementId} claims VERIFIED without a source SHA.`);
  }
  if (run.maintainabilityCoverage !== undefined && (!run.maintainabilityCoverage || typeof run.maintainabilityCoverage !== 'object')) throw new Error('Report maintainabilityCoverage must be an object when present.');
}

function validateRun(run) {
  if (!run || typeof run !== 'object') throw new Error('Report input must be a JSON object.');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(run.runId || ''))) throw new Error('Report runId is missing or invalid.');
  if (!run.repository || typeof run.repository !== 'object' || !run.repository.name) throw new Error('Report repository identity is missing.');
  if (!Array.isArray(run.engines) || !Array.isArray(run.findings)) throw new Error('Report must contain engines and findings arrays.');
  validateFunctionMeasurements(run);
  const contextSha = run.repository.contextCommitSha || null;
  const legacySha = run.repository.commitSha || null;
  if (contextSha && legacySha && contextSha !== legacySha) throw new Error('Report has inconsistent contextCommitSha and commitSha values.');
  const engineNames = new Set();
  for (const engine of run.engines) {
    if (!engine || !engine.name || engineNames.has(engine.name)) throw new Error('Report contains a missing or duplicate engine.');
    engineNames.add(engine.name);
    if (!MEASUREMENT_STATUSES.has(engine.measurementStatus)) throw new Error(`Report engine ${engine.name} has an invalid measurement status.`);
    const source = sourceRevisionOf(engine);
    if (source.status === 'VERIFIED' && !source.sha) throw new Error(`Report engine ${engine.name} claims VERIFIED without a source SHA.`);
    if (source.status === 'UNKNOWN' && source.sha) throw new Error(`Report engine ${engine.name} claims UNKNOWN with a source SHA.`);
  }
  for (const finding of run.findings) {
    if (!finding || !finding.id || !engineNames.has(finding.engine)) throw new Error('Report contains a finding with an unknown engine or missing ID.');
    const engine = run.engines.find((item) => item.name === finding.engine);
    const findingSource = finding.provenance?.sourceRevision;
    const engineSource = sourceRevisionOf(engine);
    if (findingSource?.sha && engineSource.sha && findingSource.sha !== engineSource.sha) throw new Error(`Finding ${finding.id} has a source SHA inconsistent with its engine.`);
  }
  if (run.comparison?.currentRunId && run.comparison.currentRunId !== run.runId) throw new Error('Report comparison currentRunId does not match runId.');
}

function validationState(engine) {
  const source = sourceRevisionOf(engine);
  if (engine.measurementStatus === 'FAILURE') return 'FAILED';
  if (engine.measurementStatus === 'PARTIAL') return 'MEASURED_UNVERIFIED';
  if (engine.measurementStatus === 'NOT_MEASURED') return 'NOT_MEASURED';
  if (engine.measurementStatus === 'SKIPPED_BY_POLICY') return 'SKIPPED';
  if (source.status === 'VERIFIED') return 'VALIDATED';
  return 'MEASURED_UNVERIFIED';
}

function findingBuckets(run) {
  const buckets = { new: [], historicalActionable: [], historicalJustified: [], resolved: Array.isArray(run.comparison?.resolved) ? run.comparison.resolved : [], reintroduced: [], unclassified: [] };
  for (const finding of run.findings) {
    if (finding.lifecycle === 'NEW') buckets.new.push(finding);
    else if (finding.lifecycle === 'HISTORICAL_ACTIONABLE') buckets.historicalActionable.push(finding);
    else if (finding.lifecycle === 'HISTORICAL_JUSTIFIED') buckets.historicalJustified.push(finding);
    else if (finding.lifecycle === 'REINTRODUCED') buckets.reintroduced.push(finding);
    else buckets.unclassified.push(finding);
  }
  return buckets;
}

function buildRecommendations(run, buckets, failures) {
  const recommendations = [];
  if (buckets.new.length || buckets.reintroduced.length) recommendations.push('Triage new or reintroduced findings with an explicit decision and evidence.');
  if (buckets.historicalActionable.length) recommendations.push('Review historical actionable findings and record their next action.');
  if ((run.comparison?.staleDecisions || []).some((decision) => decision.status === 'STALE')) recommendations.push('Review stale decisions before relying on historical justifications.');
  if (failures.length) recommendations.push('Resolve failed, skipped or unmeasured scanners before treating this audit as complete.');
  if (!recommendations.length) recommendations.push('No additional recommendation was derived from the recorded evidence.');
  return recommendations;
}

const STRUCTURAL_METRICS = ['decisionCount', 'maxDecisionDepth', 'nestedDecisionCount', 'maxSubtreeDecisionCount'];

function buildStructuralComplexity(measurements) {
  const grouped = new Map();
  for (const measurement of Array.isArray(measurements) ? measurements : []) {
    if (!STRUCTURAL_METRICS.includes(measurement.metricId) || measurement.status !== 'MEASURED') continue;
    const key = `${measurement.path}\0${measurement.functionId}`;
    if (!grouped.has(key)) grouped.set(key, { path: measurement.path, functionId: measurement.functionId, functionName: measurement.functionName, astRole: measurement.astRole, startLine: measurement.startLine, endLine: measurement.endLine, values: {} });
    const entry = grouped.get(key);
    entry.values[measurement.metricId] = measurement.value;
    if (measurement.metricId === 'maxSubtreeDecisionCount') {
      entry.maxSubtreeStartLine = measurement.subtreeStartLine ?? null;
      entry.maxSubtreeEndLine = measurement.subtreeEndLine ?? null;
      entry.maxSubtreeRootKind = measurement.subtreeRootKind ?? null;
    }
  }
  return [...grouped.values()]
    .filter((entry) => STRUCTURAL_METRICS.every((metric) => Number.isFinite(entry.values[metric])) && entry.values.decisionCount > 0)
    .map((entry) => {
      const { values } = entry;
      const signals = [];
      if (values.decisionCount >= 2) signals.push('multiple decisions');
      if (values.maxDecisionDepth > 1) signals.push('nested decisions');
      if (values.nestedDecisionCount > 0) signals.push('nested decision count');
      if (values.maxSubtreeDecisionCount >= 2) signals.push('decision concentration');
      if (signals.length < 2) return null;
      const subtree = entry.maxSubtreeStartLine !== null && entry.maxSubtreeEndLine !== null
        ? `in the subtree at lines ${entry.maxSubtreeStartLine}-${entry.maxSubtreeEndLine}`
        : 'in the most concentrated subtree';
      return {
        path: entry.path,
        functionId: entry.functionId,
        functionName: entry.functionName,
        astRole: entry.astRole,
        startLine: entry.startLine,
        endLine: entry.endLine,
        decisionCount: values.decisionCount,
        maxDecisionDepth: values.maxDecisionDepth,
        nestedDecisionCount: values.nestedDecisionCount,
        maxSubtreeDecisionCount: values.maxSubtreeDecisionCount,
        maxSubtreeStartLine: entry.maxSubtreeStartLine,
        maxSubtreeEndLine: entry.maxSubtreeEndLine,
        maxSubtreeRootKind: entry.maxSubtreeRootKind,
        signals,
        explanation: `This function contains ${values.decisionCount} decisions, including ${values.maxSubtreeDecisionCount} ${subtree}, with a maximum depth of ${values.maxDecisionDepth} levels.`,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.functionId.localeCompare(right.functionId));
}

function buildStructuredReport(inputRun, options = {}) {
  validateRun(inputRun);
  const run = sanitizeForExport(inputRun);
  const buckets = findingBuckets(run);
  // Rebuild from findings and engine evidence so an imported/stale `run.clones`
  // section cannot promote an unmeasured jscpd run to MEASURED.
  const clones = buildCloneAudit(run);
  const measurements = run.engines.map((engine) => {
    const source = sourceRevisionOf(engine);
    return {
      runId: run.runId,
      sha: source.sha,
      contextSha: run.repository.contextCommitSha || run.repository.commitSha || null,
      scope: engine.scope || run.inputScope || 'UNKNOWN',
      engine: engine.name,
      version: engine.version || 'UNKNOWN',
      measurementStatus: engine.measurementStatus,
      validationState: validationState(engine),
      sourceRevision: source,
      gateOutcome: engine.gateOutcome || 'NOT_EVALUATED',
      ...(engine.diagnostic ? { diagnostic: engine.diagnostic } : {}),
    };
  });
  const failures = measurements.filter((measurement) => measurement.validationState !== 'VALIDATED' || measurement.measurementStatus !== 'MEASURED');
  const structuralComplexity = buildStructuralComplexity(run.functionMeasurements);
  const maintainabilityTrends = options.maintainabilityTrends ? sanitizeForExport(options.maintainabilityTrends) : null;
  return {
    schemaVersion: '0.1-draft',
    reportVersion: '0.1-draft',
    reportType: 'QUALITY_AUDIT_RUN_REPORT',
    runId: run.runId,
    source: { repository: run.repository.name, contextSha: run.repository.contextCommitSha || run.repository.commitSha || null, inputScope: run.inputScope, reproducible: run.reproducible, generatedAt: run.generatedAt || null },
    measurements,
    findings: buckets,
    ...(Array.isArray(run.functionMeasurements) ? { functionMeasurements: run.functionMeasurements } : {}),
    ...(run.maintainabilityCoverage ? { maintainabilityCoverage: run.maintainabilityCoverage } : {}),
    structuralComplexity,
    ...(maintainabilityTrends ? { maintainabilityTrends } : {}),
    clones,
    measurementFailures: failures,
    recommendations: buildRecommendations(run, buckets, failures),
    ...(Array.isArray(run.diagnostics) && run.diagnostics.length ? { diagnostics: run.diagnostics } : {}),
    ...(run.comparison ? { comparison: run.comparison } : {}),
    ...(run.qualityGate ? { qualityGate: run.qualityGate } : {}),
  };
}

function cell(value) { return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

function findingTable(title, findings) {
  const lines = [`### ${title}`, ''];
  if (!findings.length) return lines.concat(['None recorded.', '']);
  lines.push('| ID | Engine | Rule | File | Severity | Measurement |', '| --- | --- | --- | --- | --- | --- |');
  for (const finding of findings) lines.push(`| ${cell(finding.id)} | ${cell(finding.engine)} | ${cell(finding.ruleId)} | ${cell(finding.path)} | ${cell(finding.severity)} | ${cell(finding.measurementStatus)} |`);
  lines.push('');
  return lines;
}

function renderMarkdown(run, options = {}) {
  const report = buildStructuredReport(run, options);
  const safeRun = sanitizeForExport(run);
  const discovery = safeRun.discovery || { packageManager: { name: null }, languages: [], workspaces: { packages: [] }, configurations: [] };
  const lines = [
    '# Quality Audit Kit report', '',
    `- Repository: \`${cell(safeRun.repository.name)}\``, `- Run: \`${safeRun.runId}\``, `- Input scope: \`${safeRun.inputScope}\``, `- Reproducible: \`${safeRun.reproducible}\``,
    `- Context Git commit: \`${cell(safeRun.repository.contextCommitSha || safeRun.repository.commitSha || 'UNKNOWN')}\``, `- Generated: \`${cell(safeRun.generatedAt || 'UNKNOWN')}\``, '',
    'No global quality score is computed by Quality Audit Kit.', '', '## Measurement status', '',
    '| Run | Scanner | Version | Scope | SHA | Validation | Status | Source revision | Findings | Diagnostic |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |',
  ];
  for (const measurement of report.measurements) {
    const count = safeRun.findings.filter((finding) => finding.engine === measurement.engine).length;
    lines.push(`| ${cell(measurement.runId)} | ${cell(measurement.engine)} | ${cell(measurement.version)} | ${cell(measurement.scope)} | ${cell(measurement.sha || 'UNKNOWN')} | ${cell(measurement.validationState)} | ${cell(measurement.measurementStatus)} | ${cell(measurement.sourceRevision.status)} | ${count} | ${cell(measurement.diagnostic || '')} |`);
  }
  lines.push('', '## Discovery', '', `- Package manager: \`${cell(discovery.packageManager?.name || 'none')}\``, `- Languages: ${discovery.languages?.length ? discovery.languages.map(cell).join(', ') : 'none detected'}`, `- Workspaces: ${discovery.workspaces?.packages?.length || 0} detected`, `- Configurations: ${discovery.configurations?.length || 0}`, '');
  if (report.maintainabilityCoverage) {
    const coverage = report.maintainabilityCoverage;
    lines.push('## Function maintainability', '', `- Coverage: \`${cell(coverage.status)}\``, `- Eligible files: ${coverage.eligibleFiles?.length || 0}`, `- Measured files: ${coverage.measuredFiles?.length || 0}`, `- Excluded files: ${coverage.excludedFiles?.length || 0}`, `- Unsupported files: ${coverage.unsupportedFiles?.length || 0}`, `- Error files: ${coverage.errorFiles?.length || 0}`, `- Functions measured: ${coverage.functionsMeasured || 0}`, '');
    if (report.functionMeasurements?.length) {
      lines.push('| File | Function | Role | Lines | Metric | Value | Status |', '| --- | --- | --- | --- | --- | ---: | --- |');
      for (const measurement of report.functionMeasurements) lines.push(`| ${cell(measurement.path)} | ${cell(measurement.functionName)} | ${cell(measurement.astRole)} | ${measurement.startLine}-${measurement.endLine} | ${cell(measurement.metricId)} | ${measurement.value} ${cell(measurement.unit)} | ${cell(measurement.status)} |`);
      lines.push('');
    } else lines.push('No function measurements recorded.', '');
  }
  lines.push('## Structural complexity', '');
  if (!report.structuralComplexity.length) lines.push('No function accumulates multiple structural decision signals.', '');
  else {
    lines.push('| File | Function | Lines | Decisions | Max depth | Nested decisions | Max subtree | Subtree lines |', '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
    for (const item of report.structuralComplexity) lines.push(`| ${cell(item.path)} | ${cell(item.functionName)} | ${item.startLine}-${item.endLine} | ${item.decisionCount} | ${item.maxDecisionDepth} | ${item.nestedDecisionCount} | ${item.maxSubtreeDecisionCount} | ${item.maxSubtreeStartLine ?? 'UNKNOWN'}-${item.maxSubtreeEndLine ?? 'UNKNOWN'} |`);
    lines.push('');
    for (const item of report.structuralComplexity) lines.push(`- ${cell(item.path)}:${item.startLine}-${item.endLine}: ${cell(item.explanation)}`);
    lines.push('');
  }
  if (safeRun.comparison) lines.push('## Historical comparison', '', `- Status: \`${cell(safeRun.comparison.status)}\``, `- Baseline run: \`${cell(safeRun.comparison.baselineRunId || 'UNKNOWN')}\``, `- Resolved: ${report.findings.resolved.length}`, '');
  if (report.maintainabilityTrends) lines.push(...renderMaintainabilityTrendsMarkdown(report.maintainabilityTrends, { title: '## Maintainability trends' }).trimEnd().split('\n'), '');
  lines.push('## Findings', '');
  lines.push(...findingTable('New', report.findings.new));
  lines.push(...findingTable('Historical actionable', report.findings.historicalActionable));
  lines.push(...findingTable('Historical justified', report.findings.historicalJustified));
  lines.push(...findingTable('Resolved', report.findings.resolved));
  lines.push(...findingTable('Reintroduced', report.findings.reintroduced));
  lines.push(...findingTable('Unclassified', report.findings.unclassified));
  lines.push(renderCloneMarkdown(report.clones, { title: '## Clone audit' }).trimEnd(), '');
  lines.push('## Measurement failures', '');
  if (!report.measurementFailures.length) lines.push('None recorded.', '');
  else for (const failure of report.measurementFailures) lines.push(`- **${cell(failure.engine)}**: ${cell(failure.measurementStatus)} / ${cell(failure.validationState)} — ${cell(failure.diagnostic || 'No diagnostic recorded.')}`);
  if (report.diagnostics?.length) lines.push('', '## Connector diagnostics', '', ...report.diagnostics.map((diagnostic) => `- **${cell(diagnostic.code || diagnostic.kind)}**: ${cell(diagnostic.message)}`), '');
  lines.push('', '## Recommendations', '', ...report.recommendations.map((item) => `- ${cell(item)}`), '');
  return `${lines.join('\n')}\n`;
}

function renderTerminal(run, options = {}) {
  const report = buildStructuredReport(run, options);
  const safeRun = sanitizeForExport(run);
  const lines = ['Quality Audit Kit report', `Repository: ${safeRun.repository.name}`, `Run: ${safeRun.runId}`, `Scope: ${safeRun.inputScope}`, `Context SHA: ${safeRun.repository.contextCommitSha || safeRun.repository.commitSha || 'UNKNOWN'}`, 'No global quality score is computed.', '', 'Measurement status', '------------------', 'Run | Engine | Version | Scope | SHA | Validation | Status | Source revision'];
  for (const measurement of report.measurements) lines.push(`${measurement.runId} | ${measurement.engine} | ${measurement.version} | ${measurement.scope} | ${measurement.sha || 'UNKNOWN'} | ${measurement.validationState} | ${measurement.measurementStatus} | ${measurement.sourceRevision.status}`);
  const counts = Object.fromEntries(Object.entries(report.findings).map(([key, findings]) => [key, findings.length]));
  lines.push('', 'Findings', '--------', `New: ${counts.new}`, `Historical actionable: ${counts.historicalActionable}`, `Historical justified: ${counts.historicalJustified}`, `Resolved: ${counts.resolved}`, `Reintroduced: ${counts.reintroduced}`, `Unclassified: ${counts.unclassified}`);
  if (report.maintainabilityCoverage) lines.push('', 'Function maintainability', '------------------------', `Coverage: ${report.maintainabilityCoverage.status}`, `Eligible files: ${report.maintainabilityCoverage.eligibleFiles?.length || 0}`, `Measured files: ${report.maintainabilityCoverage.measuredFiles?.length || 0}`, `Excluded files: ${report.maintainabilityCoverage.excludedFiles?.length || 0}`, `Unsupported files: ${report.maintainabilityCoverage.unsupportedFiles?.length || 0}`, `Error files: ${report.maintainabilityCoverage.errorFiles?.length || 0}`, `Functions measured: ${report.maintainabilityCoverage.functionsMeasured || 0}`, `Function measurements: ${report.functionMeasurements?.length || 0}`);
  lines.push('', 'Structural complexity', '---------------------', `Functions with multiple signals: ${report.structuralComplexity.length}`);
  for (const item of report.structuralComplexity) lines.push(`${item.path}:${item.startLine}-${item.endLine} | ${item.functionName} | ${item.explanation}`);
  if (report.maintainabilityTrends) lines.push('', renderMaintainabilityTrendsTerminal(report.maintainabilityTrends).trimEnd());
  lines.push('', 'Clone audit', '-----------', `Status: ${report.clones.status}`, `Families: ${report.clones.counts.families}`, `Unique occurrences: ${report.clones.counts.occurrences}`, `Unique pairs: ${report.clones.counts.pairs}`);
  const listed = [...report.findings.new, ...report.findings.historicalActionable, ...report.findings.historicalJustified, ...report.findings.reintroduced, ...report.findings.unclassified];
  if (listed.length) { lines.push('', 'ID | Engine | Rule | File | Severity | Lifecycle'); for (const finding of listed) lines.push(`${finding.id} | ${finding.engine} | ${finding.ruleId} | ${finding.path} | ${finding.severity} | ${finding.lifecycle}`); }
  lines.push('', 'Measurement failures', '--------------------');
  if (!report.measurementFailures.length) lines.push('None recorded.');
  else for (const failure of report.measurementFailures) lines.push(`${failure.engine}: ${failure.measurementStatus} / ${failure.validationState} — ${failure.diagnostic || 'No diagnostic recorded.'}`);
  if (report.diagnostics?.length) for (const diagnostic of report.diagnostics) lines.push(`Connector diagnostic: ${diagnostic.code || diagnostic.kind} — ${diagnostic.message}`);
  lines.push('', 'Recommendations', '---------------', ...report.recommendations.map((item) => `- ${item}`));
  return `${lines.join('\n')}\n`;
}

function writeAtomicExclusive(outputPath, content) {
  if (!outputPath || outputPath === '-') return false;
  const target = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lockPath = `${target}.qak-lock`;
  const tempPath = `${target}.qak-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const lockToken = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  let lockFd;
  let tempFd;
  try {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockFd, lockToken, 'utf8');
      fs.fsyncSync(lockFd);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Refusing concurrent write; artifact lock exists: ${target}`);
      throw error;
    }
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing artifact: ${target}`);
    tempFd = fs.openSync(tempPath, 'wx');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    fs.writeSync(tempFd, buffer, 0, buffer.length);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing artifact: ${target}`);
    fs.renameSync(tempPath, target);
    return true;
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

function writeOutput(outputPath, content) { return writeAtomicExclusive(outputPath, content); }

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
  }
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function u16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value, 0); return buffer; }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0, 0); return buffer; }

function validateZipName(name) { if (!name || path.posix.isAbsolute(name) || name.includes('..') || name.includes('\\')) throw new Error(`Unsafe ZIP entry name: ${name}`); }

function createZip(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    validateZipName(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const checksum = crc32(data);
    const header = Buffer.concat([Buffer.from('504b0304', 'hex'), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
    localParts.push(header, data);
    centralParts.push(Buffer.concat([Buffer.from('504b0102', 'hex'), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += header.length + data.length;
  }
  const local = Buffer.concat(localParts), central = Buffer.concat(centralParts);
  const end = Buffer.concat([Buffer.from('504b0506', 'hex'), u16(0), u16(0), u16(sorted.length), u16(sorted.length), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}

function readZipEntries(archive) {
  const buffer = Buffer.isBuffer(archive) ? archive : fs.readFileSync(archive);
  const start = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= start; index -= 1) if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record is missing.');
  const count = buffer.readUInt16LE(eocd + 10), centralSize = buffer.readUInt32LE(eocd + 12), centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP central directory is truncated.');
  const entries = new Map(); let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid.');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), compressedSize = buffer.readUInt32LE(cursor + 20), uncompressedSize = buffer.readUInt32LE(cursor + 24), nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32), localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength); validateZipName(name);
    if (flags & 1 || localOffset + 30 > buffer.length) throw new Error(`Unsupported or truncated ZIP entry: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28), dataStart = localOffset + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP entry is truncated: ${name}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP compression method for ${name}.`);
    if (data.length !== uncompressedSize || crc32(data) !== buffer.readUInt32LE(cursor + 16)) throw new Error(`ZIP entry checksum or size is invalid: ${name}`);
    if (entries.has(name)) throw new Error(`ZIP contains duplicate entry: ${name}`);
    entries.set(name, data); cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseChecksums(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
    if (!match) throw new Error('checksums.sha256 contains an invalid line.');
    return { sha256: match[1].toLowerCase(), path: match[2] };
  });
}

function contentMetadata(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source} contains an invalid content entry.`);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['authorized', 'bytes', 'path', 'sha256'])) throw new Error(`${source} contains unexpected content metadata.`);
  if (typeof value.path !== 'string' || !value.path) throw new Error(`${source} contains an unsafe content path.`);
  try { validateZipName(value.path); } catch { throw new Error(`${source} contains an unsafe content path.`); }
  if (!/^[a-f0-9]{64}$/i.test(String(value.sha256 || ''))) throw new Error(`${source} contains an invalid SHA-256.`);
  if (!Number.isInteger(value.bytes) || value.bytes < 0) throw new Error(`${source} contains an invalid byte count.`);
  if (typeof value.authorized !== 'boolean') throw new Error(`${source} contains an invalid authorization flag.`);
  return { path: value.path, bytes: value.bytes, sha256: value.sha256.toLowerCase(), authorized: value.authorized };
}

function sortedMetadata(entries) {
  return entries.map((entry) => contentMetadata(entry, 'Bundle content metadata')).sort((left, right) => left.path.localeCompare(right.path));
}

function samePath(left, right) {
  const normalize = (value) => path.normalize(value);
  if (process.platform === 'win32') return normalize(left).toLowerCase() === normalize(right).toLowerCase();
  return normalize(left) === normalize(right);
}

function verifyBundle(bundlePath) {
  const entries = readZipEntries(bundlePath);
  const fixedEntries = ['manifest.json', 'inventory.json', 'checksums.sha256', 'run.json', 'report.json', 'report.md', 'summary.txt', 'VERIFY.txt'];
  for (const required of fixedEntries) if (!entries.has(required)) throw new Error(`Bundle is missing ${required}.`);
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8')), inventory = JSON.parse(entries.get('inventory.json').toString('utf8')), run = JSON.parse(entries.get('run.json').toString('utf8'));
  validateRun(run);
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.contentFiles) || manifest.inventory !== 'inventory.json' || manifest.checksums !== 'checksums.sha256') throw new Error('Bundle manifest is incomplete or inconsistent.');
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.entries)) throw new Error('Bundle inventory is incomplete or inconsistent.');
  if (manifest.runId !== run.runId || inventory.runId !== run.runId) throw new Error('Bundle manifest, inventory and runId do not agree.');
  const expectedContextSha = run.repository.contextCommitSha || run.repository.commitSha || null;
  if ((manifest.contextSha || null) !== expectedContextSha) throw new Error('Bundle manifest context SHA does not agree with run.json.');
  const manifestItems = sortedMetadata(manifest.contentFiles);
  const inventoryItems = sortedMetadata(inventory.entries);
  if (JSON.stringify(manifestItems) !== JSON.stringify(inventoryItems)) throw new Error('Bundle manifest and inventory metadata do not agree.');
  const contentPaths = new Set();
  for (const item of manifestItems) {
    if (contentPaths.has(item.path)) throw new Error(`Bundle content inventory contains a duplicate path: ${item.path}`);
    contentPaths.add(item.path);
  }
  const checksums = parseChecksums(entries.get('checksums.sha256').toString('utf8')), listed = new Set();
  for (const checksum of checksums) {
    try { validateZipName(checksum.path); } catch { throw new Error(`Bundle checksum references an unsafe path: ${checksum.path}`); }
    if (listed.has(checksum.path) || !entries.has(checksum.path) || !contentPaths.has(checksum.path)) throw new Error(`Bundle checksum references a missing, duplicate or unlisted path: ${checksum.path}`);
    listed.add(checksum.path);
    if (sha256(entries.get(checksum.path)) !== checksum.sha256) throw new Error(`Bundle checksum mismatch: ${checksum.path}`);
  }
  const manifestPaths = manifestItems.map((item) => item.path), checksumPaths = [...listed].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(manifestPaths) !== JSON.stringify(checksumPaths)) throw new Error('Bundle manifest and checksums inventory do not agree.');
  const expectedZipPaths = new Set([...fixedEntries, ...contentPaths]);
  const actualZipPaths = new Set(entries.keys());
  if (actualZipPaths.size !== expectedZipPaths.size || [...actualZipPaths].some((entry) => !expectedZipPaths.has(entry))) throw new Error('Bundle contains an entry that is not fully inventoried.');
  for (const item of manifestItems) {
    const data = entries.get(item.path);
    if (!data || data.length !== item.bytes || sha256(data) !== item.sha256) throw new Error(`Bundle content metadata does not match the actual entry: ${item.path}`);
  }
  return { verified: true, runId: run.runId, contextSha: expectedContextSha, entries: [...entries.keys()].sort(), checksums: checksums.length };
}

function evidenceList(options) { const value = options['include-evidence'] ?? options.evidence; if (value === undefined || value === true || value === '') return []; return String(value).split(',').map((item) => item.trim()).filter(Boolean); }

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function evidenceLabel(root, selected) {
  const absolute = path.resolve(root, String(selected));
  const relative = path.relative(path.resolve(root), absolute);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : '<outside-authorized-directory>';
}

function realPath(candidate) {
  const resolver = fs.realpathSync.native || fs.realpathSync;
  return resolver(candidate);
}

function sameFileSnapshot(left, right) {
  return left.isFile() && right.isFile()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && (!left.dev || !right.dev || left.dev === right.dev)
    && (!left.ino || !right.ino || left.ino === right.ino);
}

function evidenceEntry(root, selected) {
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, selected);
  const relative = path.relative(resolvedRoot, absolute);
  if (!isInside(resolvedRoot, absolute)) throw new Error(`Evidence must remain inside the run directory: ${evidenceLabel(root, selected)}`);
  let effectiveRoot;
  let effectiveFile;
  try {
    effectiveRoot = realPath(resolvedRoot);
    effectiveFile = realPath(absolute);
  } catch {
    throw new Error(`Evidence file could not be resolved safely: ${evidenceLabel(root, selected)}`);
  }
  if (!isInside(effectiveRoot, effectiveFile)) throw new Error(`Evidence destination escapes the authorized run directory: ${evidenceLabel(root, selected)}`);
  const normalized = relative.split(path.sep).join('/'), extension = path.extname(normalized).toLowerCase(), lowerName = normalized.toLowerCase();
  if (!SAFE_EVIDENCE_EXTENSIONS.has(extension) || SOURCE_EXTENSIONS.has(extension) || /(?:\.env|secret|token|credential|password|private|id_rsa)/i.test(lowerName)) throw new Error(`Evidence file is not an approved non-source artifact: ${evidenceLabel(root, selected)}`);
  let fd;
  let data;
  try {
    fd = fs.openSync(absolute, 'r');
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('Evidence path is not a regular file.');
    const openedFile = realPath(absolute);
    if (!samePath(openedFile, effectiveFile) || !isInside(effectiveRoot, openedFile)) throw new Error('Evidence path changed while it was being opened.');
    data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!sameFileSnapshot(before, after)) throw new Error('Evidence file changed while it was being read.');
    const finalFile = realPath(absolute);
    const finalPathStat = fs.statSync(absolute);
    if (!samePath(finalFile, effectiveFile) || !isInside(effectiveRoot, finalFile) || !sameFileSnapshot(after, finalPathStat)) throw new Error('Evidence path changed before it could be safely included.');
  } catch (error) {
    throw new Error(`Evidence file could not be read safely: ${error.message}`);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  if (data.includes(0)) throw new Error(`Evidence file is binary and was refused: ${selected}`);
  const text = sanitizeString(data.toString('utf8'));
  if (text.includes('[REDACTED_TOKEN]') || text.includes('[REDACTED_KEY]') || text.includes('[REDACTED_SECRET]')) throw new Error(`Evidence file contains a sensitive token or secret: ${selected}`);
  return { name: `evidence/${normalized}`, data: Buffer.from(text, 'utf8') };
}

function jsonBuffer(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function createBundle(run, inputPath, bundlePath, options = {}) {
  validateRun(run);
  const safeRun = sanitizeForExport(run), structured = buildStructuredReport(run);
  const entries = new Map([
    ['run.json', jsonBuffer(safeRun)], ['report.json', jsonBuffer(structured)], ['report.md', Buffer.from(renderMarkdown(run), 'utf8')], ['summary.txt', Buffer.from(renderTerminal(run), 'utf8')],
    ['VERIFY.txt', Buffer.from('Offline verification command:\n  quality-audit-kit report --verify-bundle <bundle.zip>\n\nThe command reads only this ZIP and verifies its internal ZIP checksums, manifest, inventory, runId and context SHA.\n', 'utf8')],
  ]);
  for (const selected of evidenceList(options)) { const evidence = evidenceEntry(path.dirname(inputPath), selected); if (entries.has(evidence.name)) throw new Error(`Duplicate bundle entry: ${evidence.name}`); entries.set(evidence.name, evidence.data); }
  const contentFiles = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, data]) => ({ path: name, bytes: data.length, sha256: sha256(data), authorized: name.startsWith('evidence/') }));
  const inventory = { schemaVersion: '0.1-draft', runId: safeRun.runId, entries: contentFiles };
  const manifest = { schemaVersion: '0.1-draft', bundleVersion: '0.1-draft', runId: safeRun.runId, contextSha: safeRun.repository.contextCommitSha || safeRun.repository.commitSha || null, inputScope: safeRun.inputScope, reproducible: safeRun.reproducible, inventory: 'inventory.json', checksums: 'checksums.sha256', contentFiles, measurements: structured.measurements };
  const checksums = `${contentFiles.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`;
  const zipEntries = [...contentFiles.map((entry) => ({ name: entry.path, data: entries.get(entry.path) })), { name: 'checksums.sha256', data: Buffer.from(checksums, 'utf8') }, { name: 'inventory.json', data: jsonBuffer(inventory) }, { name: 'manifest.json', data: jsonBuffer(manifest) }];
  writeAtomicExclusive(bundlePath, createZip(zipEntries));
  return { bundlePath, runId: safeRun.runId, entries: zipEntries.map((entry) => entry.name).sort(), contentFiles: contentFiles.length };
}

module.exports = { buildStructuredReport, createBundle, createZip, readZipEntries, renderMarkdown, renderTerminal, sanitizeForExport, validateRun, verifyBundle, writeAtomicExclusive, writeOutput };
