const crypto = require('node:crypto');
const path = require('node:path');

const MEASUREMENT_STATUSES = ['MEASURED', 'NOT_MEASURED', 'FAILURE', 'SKIPPED_BY_POLICY'];
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

function severity(value, fallback = 'INFO') {
  const normalized = String(value || '').toUpperCase();
  if (SEVERITIES.includes(normalized)) return normalized;
  if (normalized === 'ERROR') return 'HIGH';
  if (normalized === 'WARN' || normalized === 'WARNING') return 'MEDIUM';
  return fallback;
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

function createFinding({ root, engine, ruleId, path: candidatePath, line, severityValue, message, locus, provenance }) {
  const filePath = safeRelativePath(root, candidatePath);
  const normalizedLocus = String(locus || message || filePath).trim();
  return {
    id: stableId(engine, ruleId, filePath, normalizedLocus),
    engine,
    ruleId,
    path: filePath,
    ...(line ? { line } : {}),
    severity: severity(severityValue),
    message: message || `${ruleId} reported for ${filePath}`,
    lifecycle: 'NEW',
    measurementStatus: 'MEASURED',
    provenance,
  };
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
  return duplicates.flatMap((duplicate) => {
    const first = duplicate?.firstFile || duplicate?.first || {};
    const second = duplicate?.secondFile || duplicate?.second || {};
    const firstPath = first.name || first.path || duplicate?.firstFile;
    const secondPath = second.name || second.path || duplicate?.secondFile;
    if (!firstPath || !secondPath) return [];
    const percentage = Number(duplicate?.format?.percentage || duplicate?.percentage || 0);
    const lines = Number(duplicate?.lines || duplicate?.lineCount || first.end - first.start || 0);
    const derivedSeverity = percentage >= 20 || lines >= 50 ? 'HIGH' : percentage >= 10 || lines >= 20 ? 'MEDIUM' : 'LOW';
    const firstRelative = safeRelativePath(root, firstPath);
    const secondRelative = safeRelativePath(root, secondPath);
    const pair = [firstRelative, secondRelative].sort().join('|');
    const locus = `${pair}|${duplicate?.fragment || duplicate?.tokens || lines}`;
    return [createFinding({
      root,
      engine: 'jscpd',
      ruleId: 'duplicate-code',
      path: firstPath,
      line: Number(first.start) || undefined,
      severityValue: derivedSeverity,
      message: `Duplicated code with ${secondRelative}${percentage ? ` (${percentage}% similarity)` : ''}`,
      locus,
      provenance,
    })];
  });
}

module.exports = {
  MEASUREMENT_STATUSES,
  createFinding,
  normalizeJscpd,
  normalizeKnip,
  safeRelativePath,
  stableId,
};
