const crypto = require('node:crypto');
const path = require('node:path');

const MEASUREMENT_STATUSES = ['MEASURED', 'PARTIAL', 'NOT_MEASURED', 'FAILURE', 'SKIPPED_BY_POLICY'];
const LIFECYCLE_STATUSES = ['UNCLASSIFIED', 'NEW', 'HISTORICAL_ACTIONABLE', 'HISTORICAL_JUSTIFIED', 'RESOLVED', 'REINTRODUCED'];
const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function safeRelativePath(root, candidate) {
  const raw = String(candidate || 'unknown').replace(/\\/g, '/');
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  let relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative === '.') return 'repository-root';
  if (relative === '..' || relative.startsWith('../')) {
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return `external/${digest}`;
  }
  return relative.replace(/^\.\//, '');
}

function stableId(engine, ruleId, filePath, locus) {
  const input = [engine, ruleId, filePath, locus || ''].join('\0');
  return `${engine}:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function jscpdOccurrenceKey(occurrence) {
  return [occurrence?.path || 'UNKNOWN', occurrence?.startLine ?? '?', occurrence?.endLine ?? '?'].join(':');
}

function jscpdPairKey(occurrences) {
  return occurrences.map(jscpdOccurrenceKey).sort().join('|');
}

function jscpdMetricIdentity({ pairKey, fragment, lines, percentage, tokens, chars }) {
  return crypto.createHash('sha256').update(JSON.stringify({ pairKey, fragment, lines, percentage, tokens, chars })).digest('hex');
}

function severity(value, fallback = 'INFO') {
  const normalized = String(value || '').toUpperCase();
  if (SEVERITIES.includes(normalized)) return normalized;
  if (normalized === 'ERROR') return 'HIGH';
  if (normalized === 'WARN' || normalized === 'WARNING') return 'MEDIUM';
  return fallback;
}

function redactMessage(value) {
  return String(value || '')
    .replace(/\b(?:ghp_|github_pat_|sk-|rk-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[REDACTED_SECRET]');
}

function getLine(item) {
  return Number(item?.line || item?.startLine || item?.location?.start?.line || item?.loc?.start?.line) || undefined;
}

function getPath(item) {
  return item?.file || item?.path || item?.filename || item?.filePath;
}

function itemMessage(item, ruleId, filePath, symbol) {
  return String(item?.message || item?.description || `${ruleId}${symbol ? `: ${symbol}` : ''}${filePath ? ` (${filePath})` : ''}`);
}

function createFinding({ root, engine, ruleId, path: candidatePath, line, severityValue, message, locus, provenance, rawReference, measurementStatus = 'MEASURED' }) {
  const filePath = safeRelativePath(root, candidatePath);
  const normalizedLocus = String(locus || message || filePath).trim();
  return {
    id: stableId(engine, ruleId, filePath, normalizedLocus),
    engine,
    ruleId,
    path: filePath,
    ...(line ? { line } : {}),
    severity: severity(severityValue),
    message: redactMessage(message || `${ruleId} reported for ${filePath}`),
    lifecycle: 'UNCLASSIFIED',
    measurementStatus,
    provenance,
    ...(rawReference ? { rawReference: String(rawReference) } : {}),
  };
}

function sarifMessage(result) {
  const message = result?.message;
  if (typeof message === 'string') return message;
  if (message && typeof message.text === 'string') return message.text;
  if (message && typeof message.markdown === 'string') return message.markdown;
  return '';
}

function sarifPath(result) {
  const physical = result?.locations?.[0]?.physicalLocation;
  const uri = physical?.artifactLocation?.uri;
  if (!uri || /^[a-z][a-z0-9+.-]*:\/\//i.test(String(uri)) && !/^file:\/\//i.test(String(uri))) return undefined;
  if (/^file:\/\//i.test(String(uri))) {
    try { return decodeURIComponent(new URL(String(uri)).pathname.replace(/^\/[A-Za-z]:/, (value) => value.slice(1))); } catch { return undefined; }
  }
  try { return decodeURIComponent(String(uri)); } catch { return String(uri); }
}

function sarifRevision(run) {
  const revision = run?.versionControlProvenance?.[0]?.revisionId;
  if (/^[a-f0-9]{40}$/i.test(String(revision || ''))) {
    return { status: 'UNVERIFIED', sha: String(revision).toLowerCase(), basis: 'SARIF declared revisionId; the imported document does not prove that the local repository content matches it.' };
  }
  return { status: 'UNKNOWN', sha: null, basis: 'SARIF did not provide a demonstrable 40-character source revision.' };
}

function normalizeSarif(root, log, provenance = {}) {
  if (!log || typeof log !== 'object' || log.version !== '2.1.0' || !Array.isArray(log.runs)) throw new Error('SARIF input must be a SARIF 2.1.0 object with a runs array.');
  const findings = [];
  const diagnostics = [];
  for (const [runIndex, run] of log.runs.entries()) {
    const driver = run?.tool?.driver || {};
    const engine = String(provenance.engine || driver.name || driver.guid || 'sarif');
    const sourceRevision = provenance.sourceRevision || sarifRevision(run);
    const rules = Array.isArray(driver.rules) ? driver.rules : [];
    const results = Array.isArray(run?.results) ? run.results : [];
    if (run?.results === null) diagnostics.push({ kind: 'SARIF_DIAGNOSTIC', code: 'NULL_RESULTS', reference: `sarif://runs/${runIndex}`, message: 'SARIF marks this run result set as unavailable; no clean result is inferred.' });
    if (run?.results === undefined) diagnostics.push({ kind: 'SARIF_DIAGNOSTIC', code: 'MISSING_RESULTS', reference: `sarif://runs/${runIndex}`, message: 'SARIF run has no results property; completeness is unverified.' });
    for (const [resultIndex, result] of results.entries()) {
      const rule = result?.ruleId || (Number.isInteger(result?.ruleIndex) ? rules[result.ruleIndex]?.id : null) || 'sarif-result';
      const filePath = sarifPath(result);
      const physical = result?.locations?.[0]?.physicalLocation;
      const line = Number(physical?.region?.startLine) || undefined;
      const message = sarifMessage(result) || `${rule} reported by ${engine}`;
      const reference = `sarif://runs/${runIndex}/results/${resultIndex}`;
      if (!filePath) diagnostics.push({ kind: 'SARIF_DIAGNOSTIC', code: 'LOCATION_NOT_REPRESENTABLE', reference, message: 'SARIF result has no repository-relative file URI; the finding is retained with an external placeholder path.' });
      for (const field of ['codeFlows', 'graphs', 'graphTraversals', 'stacks', 'relatedLocations', 'fixes']) {
        if (result?.[field] !== undefined) diagnostics.push({ kind: 'SARIF_DIAGNOSTIC', code: 'FIELD_NOT_REPRESENTABLE', reference, message: `SARIF ${field} was not copied into the canonical finding.`, details: { field, count: Array.isArray(result[field]) ? result[field].length : 1 } });
      }
      const finding = createFinding({
        root,
        engine,
        ruleId: String(rule),
        path: filePath || `external/sarif-${runIndex}-${resultIndex}`,
        line,
        severityValue: result?.properties?.severity || result?.level,
        message,
        locus: result?.guid || result?.correlationGuid || result?.fingerprints?.['qak/v1'] || message,
        provenance: { kind: provenance.kind || 'REPORT', reference: provenance.reference || reference, sourceRevision },
        rawReference: reference,
      });
      findings.push(finding);
    }
  }
  return { findings, diagnostics };
}

function issueArrays(report) {
  const arrays = [];
  if (Array.isArray(report)) arrays.push(['finding', report]);
  if (!report || typeof report !== 'object') return arrays;
  for (const [key, value] of Object.entries(report)) {
    if (Array.isArray(value)) arrays.push([key, value]);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (Array.isArray(nestedValue)) arrays.push([nestedKey, nestedValue]);
      }
    }
  }
  return arrays;
}

function normalizeKnip(root, report, provenance) {
  if (!report || typeof report !== 'object') throw new Error('Knip report must be a JSON object or array');
  const findings = [];
  const knownKeys = new Set(['issues', 'files', 'unlisted', 'unresolved', 'exports', 'types', 'duplicates']);
  const present = issueArrays(report).filter(([key]) => knownKeys.has(key) || key === 'finding');
  if (!Array.isArray(report) && present.length === 0) throw new Error('Unsupported Knip JSON report shape');

  for (const [category, items] of present) {
    for (const item of items) {
      if (typeof item === 'string') {
        findings.push(createFinding({ root, engine: 'knip', ruleId: category, path: item, message: `${category}: ${item}`, locus: item, provenance }));
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const candidatePath = getPath(item) || item.fileName;
      if (!candidatePath) continue;
      if (category === 'issues') {
        const issueTypes = Object.entries(item).filter(([key, value]) => key !== 'file' && key !== 'owners' && Array.isArray(value));
        if (issueTypes.length === 0) {
          findings.push(createFinding({
            root,
            engine: 'knip',
            ruleId: 'issue',
            path: candidatePath,
            line: getLine(item),
            severityValue: item.severity,
            message: itemMessage(item, 'issue', candidatePath, ''),
            locus: itemMessage(item, 'issue', candidatePath, ''),
            provenance,
          }));
          continue;
        }
        for (const [issueType, issueItems] of issueTypes) {
          for (const issueItem of issueItems) {
            const detail = typeof issueItem === 'string' ? { name: issueItem } : issueItem || {};
            const symbol = detail.name || detail.symbol || detail.identifier || '';
            findings.push(createFinding({
              root,
              engine: 'knip',
              ruleId: issueType,
              path: candidatePath,
              line: getLine(detail),
              severityValue: detail.severity || item.severity,
              message: String(detail.message || `${issueType}: ${symbol || candidatePath}`),
              locus: `${issueType}:${symbol || detail.line || ''}`,
              provenance,
            }));
          }
        }
        continue;
      }
      const ruleId = String(item.ruleId || item.rule || item.type || category);
      const symbol = item.symbol || item.name || item.export || item.identifier || '';
      findings.push(createFinding({
        root,
        engine: 'knip',
        ruleId,
        path: candidatePath,
        line: getLine(item),
        severityValue: item.severity,
        message: itemMessage(item, ruleId, candidatePath, symbol),
        locus: symbol || itemMessage(item, ruleId, candidatePath, symbol),
        provenance,
      }));
    }
  }
  return findings;
}

function normalizeJscpd(root, report, provenance) {
  const duplicates = Array.isArray(report) ? report : report?.duplicates;
  if (!Array.isArray(duplicates)) throw new Error('Unsupported jscpd JSON report shape');
  const diagnostics = [];
  const findings = [];
  const findingIds = new Set();
  for (const [index, duplicate] of duplicates.entries()) {
    const first = duplicate?.firstFile || duplicate?.first || {};
    const second = duplicate?.secondFile || duplicate?.second || {};
    const firstPath = first.name || first.path || duplicate?.firstFile;
    const secondPath = second.name || second.path || duplicate?.secondFile;
    const reference = `jscpd://duplicates/${index}`;
    if (!firstPath || !secondPath) {
      diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_PATH_MISSING', reference, message: 'jscpd duplicate did not provide both file paths; the clone was not retained.' });
      continue;
    }
    const firstRelative = safeRelativePath(root, firstPath);
    const secondRelative = safeRelativePath(root, secondPath);
    if (firstRelative.startsWith('external/')) diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_PATH_OUTSIDE_REPOSITORY', reference, message: 'jscpd first file is outside the repository; an external placeholder path was retained.' });
    if (secondRelative.startsWith('external/')) diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_PATH_OUTSIDE_REPOSITORY', reference, message: 'jscpd second file is outside the repository; an external placeholder path was retained.' });
    const range = (file, side) => {
      const start = Number(file?.start ?? file?.startLine);
      const end = Number(file?.end ?? file?.endLine);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_RANGE_UNAVAILABLE', reference, message: `jscpd ${side} file has no complete integer line range.` });
        return { startLine: null, endLine: null };
      }
      if (start < 1 || end < start) {
        diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_RANGE_INVALID', reference, message: `jscpd ${side} file has an invalid line range.` });
        return { startLine: null, endLine: null };
      }
      return { startLine: start, endLine: end };
    };
    const firstRange = range(first, 'first');
    const secondRange = range(second, 'second');
    const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    const percentage = numeric(duplicate?.format?.percentage ?? duplicate?.percentage);
    const lines = numeric(duplicate?.lines ?? duplicate?.lineCount ?? duplicate?.format?.lines);
    const tokens = numeric(duplicate?.tokens ?? duplicate?.format?.tokens);
    const chars = numeric(duplicate?.chars ?? duplicate?.format?.chars);
    const fragment = duplicate?.fragment ?? duplicate?.format?.fragment ?? null;
    if (percentage === null && lines === null && tokens === null && chars === null && fragment === null) diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_METRICS_UNAVAILABLE', reference, message: 'jscpd duplicate did not provide a usable clone metric.' });
    const severityLines = lines ?? (firstRange.startLine !== null ? firstRange.endLine - firstRange.startLine + 1 : 0);
    const derivedSeverity = percentage !== null && percentage >= 20 || severityLines >= 50
      ? 'HIGH'
      : percentage !== null && percentage >= 10 || severityLines >= 20
        ? 'MEDIUM'
        : 'LOW';
    const nativeFingerprint = ['fingerprint', 'cloneId', 'nativeId', 'id'].map((key) => duplicate?.[key]).find((value) => value !== undefined && value !== null && String(value).trim() !== '');
    const occurrences = [
      { side: 'first', path: firstRelative, startLine: firstRange.startLine, endLine: firstRange.endLine },
      { side: 'second', path: secondRelative, startLine: secondRange.startLine, endLine: secondRange.endLine },
    ];
    const pairKey = jscpdPairKey(occurrences);
    const stableCloneKey = nativeFingerprint
      ? `native:${String(nativeFingerprint)}`
      : `derived:qak:${jscpdMetricIdentity({ pairKey, fragment, lines, percentage, tokens, chars })}`;
    const derivedKey = jscpdMetricIdentity({ pairKey, fragment, lines, percentage, tokens, chars });
    const canonicalOccurrence = [...occurrences].sort((left, right) => jscpdOccurrenceKey(left).localeCompare(jscpdOccurrenceKey(right)))[0];
    const finding = createFinding({
      root,
      engine: 'jscpd',
      ruleId: 'duplicate-code',
      path: canonicalOccurrence.path,
      line: canonicalOccurrence.startLine || undefined,
      severityValue: derivedSeverity,
      message: `Duplicated code with ${secondRelative}${percentage !== null ? ` (${percentage}% similarity)` : ''}`,
      locus: `${stableCloneKey}|pair:${pairKey}`,
      provenance,
      rawReference: reference,
    });
    if (findingIds.has(finding.id)) {
      diagnostics.push({ kind: 'JSCPD_DIAGNOSTIC', code: 'CLONE_DUPLICATE_DEDUPLICATED', reference, message: 'jscpd repeated an identical clone pair; the duplicate was omitted from canonical findings.' });
      continue;
    }
    findingIds.add(finding.id);
    finding.clone = {
      scope: firstRelative === secondRelative ? 'INTRA_FILE' : 'INTER_FILE',
      grouping: nativeFingerprint
        ? { source: 'NATIVE_FINGERPRINT', key: String(nativeFingerprint), derived: false }
        : { source: 'DERIVED_PAIR_CHARACTERISTICS', key: `qak:${derivedKey}`, derived: true },
      nativeFingerprint: nativeFingerprint ? { value: String(nativeFingerprint), source: 'REPORT', verified: true } : null,
      identity: {
        stableClone: stableCloneKey,
        occurrence: occurrences.map(jscpdOccurrenceKey),
        pair: pairKey,
        family: nativeFingerprint ? `native:${String(nativeFingerprint)}` : `derived:qak:${derivedKey}`,
      },
      occurrences,
      metrics: { lines, percentage, tokens, chars, fragment },
      dataAvailability: diagnostics.some((item) => item.reference === reference) ? 'PARTIAL' : 'COMPLETE',
    };
    findings.push(finding);
  }
  Object.defineProperty(findings, 'diagnostics', { value: diagnostics, enumerable: false });
  return findings;
}

function normalizeSonar(root, issues, provenance) {
  if (!Array.isArray(issues)) throw new Error('SonarQube issues must be an array.');
  const diagnostics = [];
  const findings = [];
  const severityMap = { BLOCKER: 'CRITICAL', CRITICAL: 'CRITICAL', MAJOR: 'HIGH', MINOR: 'MEDIUM', INFO: 'INFO' };
  for (const [index, issue] of issues.entries()) {
    const reference = `sonarqube://issues/${encodeURIComponent(String(issue?.key || index))}`;
    const component = String(issue?.component || '');
    const separator = component.indexOf(':');
    const candidatePath = separator >= 0 ? component.slice(separator + 1) : component;
    if (!candidatePath) diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'LOCATION_NOT_REPRESENTABLE', reference, message: 'SonarQube issue has no component path; a safe placeholder path was used.' });
    for (const field of ['flows', 'locations', 'quickFixAvailable', 'cleanCodeAttribute', 'impacts', 'effort', 'debt', 'tags', 'textRange']) {
      if (issue?.[field] !== undefined && ['flows', 'locations', 'impacts'].includes(field)) diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'FIELD_NOT_REPRESENTABLE', reference, message: `SonarQube ${field} metadata was not copied into the canonical finding.`, details: { field, count: Array.isArray(issue[field]) ? issue[field].length : 1 } });
    }
    const line = Number(issue?.line || issue?.textRange?.startLine) || undefined;
    findings.push(createFinding({
      root,
      engine: 'sonarqube',
      ruleId: String(issue?.rule || issue?.type || 'sonar-issue'),
      path: candidatePath || `external/sonarqube-${index}`,
      line,
      severityValue: severityMap[String(issue?.severity || '').toUpperCase()] || issue?.severity,
      message: String(issue?.message || issue?.rule || 'SonarQube issue'),
      locus: issue?.key || `${issue?.rule || 'sonar-issue'}:${issue?.message || index}`,
      provenance,
      rawReference: reference,
      measurementStatus: provenance.measurementStatus || 'MEASURED',
    }));
  }
  return { findings, diagnostics };
}

module.exports = {
  LIFECYCLE_STATUSES,
  MEASUREMENT_STATUSES,
  createFinding,
  normalizeJscpd,
  normalizeKnip,
  normalizeSarif,
  normalizeSonar,
  safeRelativePath,
  stableId,
};
