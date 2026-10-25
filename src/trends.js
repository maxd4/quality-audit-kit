const fs = require('node:fs');
const path = require('node:path');

const ENGINE_NAME = 'maintainability';
const TREND_SCHEMA_VERSION = '0.1-draft';
const TREND_STATUSES = new Set(['IMPROVED', 'DEGRADED', 'UNCHANGED', 'NOT_COMPARABLE', 'NOT_MEASURED']);
const SOURCE_STATUSES = new Set(['VERIFIED', 'UNVERIFIED', 'UNKNOWN']);
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const CONTENT_SHA_PATTERN = /^[a-f0-9]{64}$/i;
const KNOWN_METRIC_IDS = ['cognitiveComplexity', 'cyclomaticComplexity', 'functionLength', 'decisionCount', 'maxDecisionDepth', 'nestedDecisionCount', 'maxSubtreeDecisionCount'];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function revisionOf(value) {
  return {
    status: SOURCE_STATUSES.has(value?.status) ? value.status : 'UNKNOWN',
    sha: SHA_PATTERN.test(String(value?.sha || '')) ? String(value.sha).toLowerCase() : null,
    basis: String(value?.basis || 'No source revision evidence was recorded.'),
  };
}

function evidenceRevision(measurement) {
  return revisionOf(measurement?.provenance?.sourceRevision);
}

function engineFor(run) {
  return (run?.engines || []).find((engine) => engine?.name === ENGINE_NAME) || null;
}

function coverageContract(run, engine, measurements, label) {
  const reasons = [];
  const coverage = run?.maintainabilityCoverage;
  const result = { valid: true, reasons };
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    reasons.push(`${label} has no maintainabilityCoverage inventory.`);
    result.valid = false;
    return result;
  }
  if (coverage.status !== 'MEASURED') reasons.push(`${label} maintainability coverage is ${coverage.status || 'UNKNOWN'}, not fully MEASURED.`);
  const collections = ['eligibleFiles', 'measuredFiles', 'excludedFiles', 'unsupportedFiles', 'errorFiles', 'engines'];
  for (const field of collections) if (!Array.isArray(coverage[field])) reasons.push(`${label} maintainability coverage has no valid ${field} collection.`);
  if (!Number.isInteger(coverage.functionsMeasured) || coverage.functionsMeasured < 0) reasons.push(`${label} maintainability coverage has an invalid functionsMeasured count.`);

  const eligibleFiles = Array.isArray(coverage.eligibleFiles) ? coverage.eligibleFiles : [];
  const eligibleByPath = new Map();
  for (const file of eligibleFiles) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !file.path) {
      reasons.push(`${label} maintainability coverage contains an invalid eligible file.`);
      continue;
    }
    if (eligibleByPath.has(file.path)) reasons.push(`${label} maintainability coverage contains duplicate eligible file ${file.path}.`);
    eligibleByPath.set(file.path, file);
    if (!['MEASURED', 'NOT_MEASURED', 'FAILURE'].includes(file.status)) reasons.push(`${label} maintainability coverage has an invalid status for ${file.path}.`);
    if (!Number.isInteger(file.functionsMeasured) || file.functionsMeasured < 0) reasons.push(`${label} maintainability coverage has an invalid function count for ${file.path}.`);
  }
  const measuredFiles = Array.isArray(coverage.measuredFiles) ? coverage.measuredFiles : [];
  const measuredPathSet = new Set();
  for (const filePath of measuredFiles) {
    if (typeof filePath !== 'string' || !filePath) reasons.push(`${label} maintainability coverage contains an invalid measured file path.`);
    else if (measuredPathSet.has(filePath)) reasons.push(`${label} maintainability coverage contains duplicate measured file ${filePath}.`);
    else measuredPathSet.add(filePath);
    if (typeof filePath === 'string' && filePath && !eligibleByPath.has(filePath)) reasons.push(`${label} maintainability coverage measures an ineligible file ${filePath}.`);
  }
  if (coverage.status === 'MEASURED') {
    if (!eligibleFiles.length) reasons.push(`${label} maintainability coverage has no eligible file inventory.`);
    if (eligibleFiles.some((file) => file?.status !== 'MEASURED')) reasons.push(`${label} maintainability coverage has an eligible file that is not MEASURED.`);
    if (measuredPathSet.size !== eligibleByPath.size || [...eligibleByPath.keys()].some((filePath) => !measuredPathSet.has(filePath))) reasons.push(`${label} maintainability coverage measuredFiles does not cover the complete eligible inventory.`);
    if ((Array.isArray(coverage.errorFiles) && coverage.errorFiles.length) || (eligibleFiles.some((file) => file?.status === 'FAILURE')) || (Array.isArray(coverage.excludedFiles) && coverage.excludedFiles.some((file) => file?.status === 'FAILURE'))) reasons.push(`${label} maintainability coverage contains discovery or file failures.`);
  }

  const coverageEngines = Array.isArray(coverage.engines) ? coverage.engines : [];
  const coverageEngine = coverageEngines.find((candidate) => candidate?.name === ENGINE_NAME);
  if (!coverageEngine) reasons.push(`${label} maintainability coverage has no maintainability engine declaration.`);
  else if (typeof coverageEngine.version !== 'string' || !coverageEngine.version) reasons.push(`${label} maintainability coverage has no maintainability engine version.`);
  if (!engine || typeof engine.version !== 'string' || !engine.version) reasons.push(`${label} maintainability engine has no version.`);
  if (coverageEngine?.version && engine?.version && coverageEngine.version !== engine.version) reasons.push(`${label} maintainability coverage engine version differs from the engine declaration.`);

  const functionIds = new Set();
  for (const measurement of measurements) {
    if (measurement?.functionId) functionIds.add(measurement.functionId);
    if (measurement?.path && (!eligibleByPath.has(measurement.path) || !measuredPathSet.has(measurement.path))) reasons.push(`${label} function measurements are outside the measured coverage inventory.`);
    const file = eligibleByPath.get(measurement?.path);
    if (file && file.status !== 'MEASURED') reasons.push(`${label} function measurements reference a file that is not MEASURED.`);
  }
  if (Number.isInteger(coverage.functionsMeasured) && coverage.functionsMeasured !== functionIds.size) reasons.push(`${label} maintainability coverage functionsMeasured does not match function measurements.`);
  for (const [filePath, file] of eligibleByPath) {
    const fileFunctions = new Set(measurements.filter((measurement) => measurement?.path === filePath).map((measurement) => measurement?.functionId).filter(Boolean));
    if (Number.isInteger(file.functionsMeasured) && file.functionsMeasured !== fileFunctions.size) reasons.push(`${label} maintainability coverage function count does not match ${filePath}.`);
  }
  if (reasons.length) result.valid = false;
  return result;
}

function contractFor(run, label) {
  const reasons = [];
  const checks = {};
  if (!run || typeof run !== 'object' || Array.isArray(run)) reasons.push(`${label} is not a JSON object.`);
  if (!run?.runId) reasons.push(`${label} has no runId.`);
  if (!run?.repository?.name) reasons.push(`${label} has no repository name.`);
  const engine = engineFor(run);
  if (!engine) reasons.push(`${label} has no ${ENGINE_NAME} engine.`);
  if (!Array.isArray(run?.functionMeasurements)) reasons.push(`${label} has no functionMeasurements array; function trends are NOT_MEASURED.`);
  if (engine && engine.measurementStatus !== 'MEASURED') reasons.push(`${label} maintainability engine is ${engine.measurementStatus || 'UNKNOWN'}, not MEASURED.`);

  const engineRevision = revisionOf(engine?.sourceRevision);
  if (engine && (engineRevision.status !== 'VERIFIED' || !engineRevision.sha)) reasons.push(`${label} maintainability engine lacks a VERIFIED source revision.`);
  if (typeof run?.inputScope !== 'string' || !run.inputScope) reasons.push(`${label} has no inputScope; measured scope is not demonstrated.`);
  const measurements = Array.isArray(run?.functionMeasurements) ? run.functionMeasurements : [];
  const coverage = coverageContract(run, engine, measurements, label);
  reasons.push(...coverage.reasons);
  const engineVersions = sortedUnique(measurements.map((measurement) => measurement?.engineVersion));
  const metricVersions = sortedUnique(measurements.map((measurement) => measurement?.metricVersion));
  if (engineVersions.length > 1) reasons.push(`${label} contains multiple maintainability engine versions.`);
  if (engineVersions.length && (!engine?.version || engineVersions.some((version) => version !== engine.version))) reasons.push(`${label} function measurement engine versions do not match the engine declaration.`);
  for (const measurement of measurements) {
    const source = evidenceRevision(measurement);
    if (measurement?.engine !== ENGINE_NAME) reasons.push(`${label} contains a function measurement from an unknown engine.`);
    if (typeof measurement?.engineVersion !== 'string' || !measurement.engineVersion) reasons.push(`${label} contains a function measurement without an engine version.`);
    if (typeof measurement?.metricVersion !== 'string' || !measurement.metricVersion) reasons.push(`${label} contains a function measurement without a versioned metric definition.`);
    if (measurement?.status !== 'MEASURED') reasons.push(`${label} contains a function measurement that is not MEASURED.`);
    if (source.status !== 'VERIFIED' || !source.sha) reasons.push(`${label} contains a function measurement without a VERIFIED source revision.`);
    if (engineRevision.sha && source.sha && engineRevision.sha !== source.sha) reasons.push(`${label} contains a function measurement attributed to a different source revision.`);
    if (measurement?.provenance?.contentSha256 !== undefined && !CONTENT_SHA_PATTERN.test(String(measurement.provenance.contentSha256))) reasons.push(`${label} contains a function measurement with an invalid content hash.`);
  }
  checks.repository = Boolean(run?.repository?.name);
  checks.runId = Boolean(run?.runId);
  checks.sourceRevision = Boolean(engineRevision.status === 'VERIFIED' && engineRevision.sha);
  checks.measurements = Array.isArray(run?.functionMeasurements) && engine?.measurementStatus === 'MEASURED';
  checks.coverage = coverage.valid;
  checks.scope = typeof run?.inputScope === 'string' && run.inputScope.length > 0;
  checks.engine = Boolean(engine && typeof engine.version === 'string' && engine.version && engineVersions.every((version) => version === engine.version));
  checks.metricDefinitions = measurements.every((measurement) => typeof measurement?.metricVersion === 'string' && measurement.metricVersion.length > 0);
  return {
    label,
    runId: run?.runId || null,
    repository: run?.repository?.name || null,
    inputScope: run?.inputScope || null,
    engine,
    engineRevision,
    engineVersion: engineVersions[0] || engine?.version || null,
    metricVersions,
    reasons: sortedUnique(reasons),
    checks,
  };
}

function functionReference(entry) {
  return {
    path: entry.path,
    functionId: entry.functionId,
    functionName: entry.functionName,
    astRole: entry.astRole,
    language: entry.language,
    startLine: entry.startLine,
    endLine: entry.endLine,
  };
}

function signatureKey(entry) {
  return [entry.path, entry.functionName, entry.astRole, entry.language].map((value) => String(value || '')).join('\0');
}

function indexFunctions(run) {
  const byId = new Map();
  const bySignature = new Map();
  const invalid = [];
  for (const measurement of Array.isArray(run?.functionMeasurements) ? run.functionMeasurements : []) {
    if (!measurement || typeof measurement !== 'object' || !measurement.functionId || !measurement.metricId) {
      invalid.push({ status: 'NOT_COMPARABLE', reason: 'INVALID_FUNCTION_MEASUREMENT_IDENTITY', measurement: clone(measurement) });
      continue;
    }
    if (!byId.has(measurement.functionId)) {
      const entry = { ...functionReference(measurement), measurements: new Map(), duplicateMetrics: new Set(), identityKeys: new Set() };
      byId.set(measurement.functionId, entry);
      const key = signatureKey(entry);
      entry.identityKeys.add(key);
      if (!bySignature.has(key)) bySignature.set(key, []);
      bySignature.get(key).push(entry);
    }
    const entry = byId.get(measurement.functionId);
    entry.identityKeys.add(signatureKey(measurement));
    if (entry.measurements.has(measurement.metricId)) entry.duplicateMetrics.add(measurement.metricId);
    else entry.measurements.set(measurement.metricId, measurement);
  }
  const collisions = [];
  for (const entry of byId.values()) {
    if (entry.duplicateMetrics.size) collisions.push({ status: 'NOT_COMPARABLE', reason: 'DUPLICATE_METRIC_FOR_FUNCTION', ...functionReference(entry), metricIds: sortedUnique([...entry.duplicateMetrics]) });
    if (entry.identityKeys.size > 1) collisions.push({ status: 'NOT_COMPARABLE', reason: 'FUNCTION_ID_COLLISION', ...functionReference(entry), identityKeys: [...entry.identityKeys].sort() });
  }
  for (const [key, entries] of bySignature) {
    if (entries.length > 1) for (const entry of entries) collisions.push({ status: 'NOT_COMPARABLE', reason: 'FUNCTION_SIGNATURE_COLLISION', ...functionReference(entry), signatureKey: key });
  }
  return { byId, bySignature, invalid, collisions };
}

function sameDefinition(previous, current) {
  const reasons = [];
  for (const field of ['engine', 'engineVersion', 'metricId', 'metricVersion', 'language', 'unit', 'direction']) {
    if (previous?.[field] !== current?.[field]) reasons.push(`${field} differs (${previous?.[field] || 'missing'} vs ${current?.[field] || 'missing'}).`);
  }
  return sortedUnique(reasons);
}

function measurementEvidence(measurement) {
  if (!measurement) return null;
  return {
    measurementId: measurement.measurementId || null,
    evidenceRef: measurement.evidenceRef || null,
    provenance: clone(measurement.provenance || null),
    sourceRevision: evidenceRevision(measurement),
  };
}

function metricResult(metricId, previous, current) {
  const base = {
    metricId,
    previousValue: previous?.value ?? null,
    currentValue: current?.value ?? null,
    absoluteDelta: null,
    relativeDelta: null,
    relativeStatus: null,
    direction: previous?.direction || current?.direction || null,
    status: 'NOT_MEASURED',
    comparabilityStatus: 'NOT_COMPARABLE',
    reasons: [],
    previousEvidence: measurementEvidence(previous),
    currentEvidence: measurementEvidence(current),
  };
  if (!previous || !current) {
    base.status = 'NOT_MEASURED';
    base.comparabilityStatus = 'NOT_MEASURED';
    base.reasons = [`${previous ? 'current' : 'previous'} measurement is absent; no zero was inferred.`];
    return base;
  }
  if (previous.status !== 'MEASURED' || current.status !== 'MEASURED') {
    base.status = 'NOT_MEASURED';
    base.comparabilityStatus = 'NOT_MEASURED';
    base.reasons = ['one or both measurements are not MEASURED.'];
    return base;
  }
  const reasons = sameDefinition(previous, current);
  const previousRevision = evidenceRevision(previous);
  const currentRevision = evidenceRevision(current);
  if (previousRevision.status !== 'VERIFIED' || currentRevision.status !== 'VERIFIED' || !previousRevision.sha || !currentRevision.sha) reasons.push('both measurement source revisions must be VERIFIED.');
  if (!Number.isFinite(previous.value) || !Number.isFinite(current.value)) reasons.push('both measurement values must be finite numbers.');
  if (reasons.length) {
    base.status = 'NOT_COMPARABLE';
    base.comparabilityStatus = 'NOT_COMPARABLE';
    base.reasons = sortedUnique(reasons);
    return base;
  }
  const delta = current.value - previous.value;
  base.absoluteDelta = delta;
  if (previous.value === 0) base.relativeStatus = 'UNDEFINED_PREVIOUS_ZERO';
  else base.relativeDelta = delta / previous.value;
  const direction = previous.direction;
  base.direction = direction;
  base.comparabilityStatus = 'COMPARABLE';
  if (delta === 0) base.status = 'UNCHANGED';
  else if (direction === 'LOWER_IS_BETTER') base.status = delta < 0 ? 'IMPROVED' : 'DEGRADED';
  else if (direction === 'HIGHER_IS_BETTER') base.status = delta > 0 ? 'IMPROVED' : 'DEGRADED';
  else {
    base.status = 'NOT_COMPARABLE';
    base.comparabilityStatus = 'NOT_COMPARABLE';
    base.reasons = ['metric direction is unknown.'];
  }
  return base;
}

function functionStatus(metrics) {
  const statuses = metrics.map((metric) => metric.status);
  if (statuses.includes('NOT_COMPARABLE')) return 'NOT_COMPARABLE';
  if (statuses.includes('NOT_MEASURED')) return 'NOT_MEASURED';
  if (statuses.includes('DEGRADED')) return 'DEGRADED';
  if (statuses.includes('IMPROVED')) return 'IMPROVED';
  if (statuses.length && statuses.every((status) => status === 'UNCHANGED')) return 'UNCHANGED';
  return 'NOT_MEASURED';
}

function matchFunctions(previousIndex, currentIndex) {
  const matches = [];
  const notComparable = [...previousIndex.collisions, ...currentIndex.collisions, ...previousIndex.invalid, ...currentIndex.invalid];
  const usedPrevious = new Set();
  const usedCurrent = new Set();
  for (const [functionId, previous] of previousIndex.byId) {
    const current = currentIndex.byId.get(functionId);
    if (!current) continue;
    if (previousIndex.collisions.some((entry) => entry.functionId === functionId) || currentIndex.collisions.some((entry) => entry.functionId === functionId)) continue;
    usedPrevious.add(functionId); usedCurrent.add(functionId);
    matches.push({ previous, current, matchedBy: 'FUNCTION_ID' });
  }
  const remainingPrevious = [...previousIndex.byId.values()].filter((entry) => !usedPrevious.has(entry.functionId) && !previousIndex.collisions.some((collision) => collision.functionId === entry.functionId));
  const remainingCurrent = [...currentIndex.byId.values()].filter((entry) => !usedCurrent.has(entry.functionId) && !currentIndex.collisions.some((collision) => collision.functionId === entry.functionId));
  const previousBySignature = new Map(); const currentBySignature = new Map();
  for (const entry of remainingPrevious) { const key = signatureKey(entry); if (!previousBySignature.has(key)) previousBySignature.set(key, []); previousBySignature.get(key).push(entry); }
  for (const entry of remainingCurrent) { const key = signatureKey(entry); if (!currentBySignature.has(key)) currentBySignature.set(key, []); currentBySignature.get(key).push(entry); }
  for (const [key, previousEntries] of previousBySignature) {
    const currentEntries = currentBySignature.get(key) || [];
    if (previousEntries.length === 1 && currentEntries.length === 1) {
      matches.push({ previous: previousEntries[0], current: currentEntries[0], matchedBy: 'FUNCTION_SIGNATURE' });
      usedPrevious.add(previousEntries[0].functionId); usedCurrent.add(currentEntries[0].functionId);
    } else if (currentEntries.length > 1 || previousEntries.length > 1) {
      for (const entry of [...previousEntries, ...currentEntries]) notComparable.push({ status: 'NOT_COMPARABLE', reason: 'FUNCTION_SIGNATURE_COLLISION', ...functionReference(entry), signatureKey: key });
      for (const entry of previousEntries) usedPrevious.add(entry.functionId);
      for (const entry of currentEntries) usedCurrent.add(entry.functionId);
    }
  }
  const added = remainingCurrent.filter((entry) => !usedCurrent.has(entry.functionId)).map((entry) => ({ status: 'ADDED', ...functionReference(entry) }));
  const removed = remainingPrevious.filter((entry) => !usedPrevious.has(entry.functionId)).map((entry) => ({ status: 'REMOVED', ...functionReference(entry) }));
  matches.sort((left, right) => signatureKey(left.current).localeCompare(signatureKey(right.current)) || left.current.functionId.localeCompare(right.current.functionId));
  return { matches, added, removed, notComparable };
}

function nonComparableKey(entry) {
  if (entry?.functionId) return `function:${entry.functionId}`;
  if (entry?.measurement?.measurementId) return `measurement:${entry.measurement.measurementId}`;
  return `entry:${entry?.reason || ''}:${signatureKey(entry)}`;
}

function summarize(functions, added, removed, notComparable) {
  const structuralNotComparable = new Set(notComparable.map(nonComparableKey));
  const counts = {
    matchedFunctions: functions.length,
    comparableFunctions: 0,
    improved: 0,
    degraded: 0,
    unchanged: 0,
    notComparable: structuralNotComparable.size,
    partiallyNotMeasured: 0,
    notMeasured: 0,
    added: added.length,
    removed: removed.length,
  };
  for (const entry of functions) {
    if (entry.status === 'IMPROVED') counts.improved += 1;
    else if (entry.status === 'DEGRADED') counts.degraded += 1;
    else if (entry.status === 'UNCHANGED') counts.unchanged += 1;
    else if (entry.status === 'NOT_COMPARABLE') counts.notComparable += 1;
    else if (entry.status === 'NOT_MEASURED') {
      const measured = entry.metrics.some((metric) => ['IMPROVED', 'DEGRADED', 'UNCHANGED'].includes(metric.status));
      if (measured) counts.partiallyNotMeasured += 1;
      else counts.notMeasured += 1;
    }
  }
  counts.comparableFunctions = counts.improved + counts.degraded + counts.unchanged;
  return counts;
}

function compareMaintainabilityRuns(previousRun, currentRun) {
  const previous = contractFor(previousRun, 'previous run');
  const current = contractFor(currentRun, 'current run');
  const reasons = [...previous.reasons, ...current.reasons];
  if (previous.runId && current.runId && previous.runId === current.runId) reasons.push('previousRunId and currentRunId must be distinct.');
  if (previous.repository && current.repository && previous.repository !== current.repository) reasons.push('repository identity differs.');
  if (previous.inputScope && current.inputScope && previous.inputScope !== current.inputScope) reasons.push('inputScope differs; the measured scopes are not compatible.');
  if (previous.engineVersion && current.engineVersion && previous.engineVersion !== current.engineVersion) reasons.push(`maintainability engine version differs (${previous.engineVersion} vs ${current.engineVersion}).`);
  const contractReasons = sortedUnique(reasons);
  const previousIndex = indexFunctions(previousRun);
  const currentIndex = indexFunctions(currentRun);
  const matched = matchFunctions(previousIndex, currentIndex);
  const functionComparisons = [];
  if (!contractReasons.length) {
    for (const match of matched.matches) {
      const metricIds = sortedUnique([...KNOWN_METRIC_IDS, ...match.previous.measurements.keys(), ...match.current.measurements.keys()]);
      const metrics = metricIds.map((metricId) => metricResult(metricId, match.previous.measurements.get(metricId), match.current.measurements.get(metricId)));
      functionComparisons.push({
        status: functionStatus(metrics),
        matchedBy: match.matchedBy,
        previous: functionReference(match.previous),
        current: functionReference(match.current),
        metrics,
        evidence: { previousSourceRevision: revisionOf(match.previous.measurements.values().next().value?.provenance?.sourceRevision), currentSourceRevision: revisionOf(match.current.measurements.values().next().value?.provenance?.sourceRevision) },
      });
    }
  }
  functionComparisons.sort((left, right) => signatureKey(left.current).localeCompare(signatureKey(right.current)) || left.current.functionId.localeCompare(right.current.functionId));
  const nonComparableFunctions = [
    ...matched.notComparable,
    ...functionComparisons
      .filter((entry) => entry.status === 'NOT_COMPARABLE')
      .map((entry) => ({
        status: 'NOT_COMPARABLE',
        reason: 'FUNCTION_METRIC_NOT_COMPARABLE',
        ...entry.current,
        metricIds: entry.metrics.filter((metric) => metric.status === 'NOT_COMPARABLE').map((metric) => metric.metricId).sort(),
        reasons: sortedUnique(entry.metrics.flatMap((metric) => metric.status === 'NOT_COMPARABLE' ? metric.reasons : [])),
      })),
  ];
  const status = contractReasons.length ? 'NOT_COMPARABLE' : 'COMPARABLE';
  const output = {
    schemaVersion: TREND_SCHEMA_VERSION,
    trendType: 'MAINTAINABILITY_TRENDS',
    status,
    previousRunId: previous.runId,
    currentRunId: current.runId,
    repository: { previous: previous.repository, current: current.repository },
    inputScope: { previous: previous.inputScope, current: current.inputScope },
    sourceRevisions: { previous: previous.engineRevision, current: current.engineRevision },
    contract: {
      status,
      reasons: contractReasons,
      checks: { previous: previous.checks, current: current.checks, runIdsDistinct: previous.runId !== current.runId, repositoryIdentity: previous.repository === current.repository, inputScopeCompatible: previous.inputScope === current.inputScope, engineVersionCompatible: previous.engineVersion === current.engineVersion },
    },
    functions: functionComparisons,
    nonComparableFunctions: nonComparableFunctions.sort((left, right) => `${left.path || ''}:${left.functionId || ''}:${left.reason}`.localeCompare(`${right.path || ''}:${right.functionId || ''}:${right.reason}`)),
    addedFunctions: contractReasons.length ? [] : matched.added.sort((left, right) => signatureKey(left).localeCompare(signatureKey(right))),
    removedFunctions: contractReasons.length ? [] : matched.removed.sort((left, right) => signatureKey(left).localeCompare(signatureKey(right))),
    summary: summarize(functionComparisons, contractReasons.length ? [] : matched.added, contractReasons.length ? [] : matched.removed, matched.notComparable),
  };
  return output;
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatMetricValue(value) {
  return value === null || value === undefined ? 'NOT_MEASURED' : String(value);
}

function renderMaintainabilityTrendsMarkdown(trends, options = {}) {
  const title = options.title || '# Maintainability trends';
  const lines = [title, '', `- Status: \`${trends?.status || 'NOT_COMPARABLE'}\``, `- Previous run: \`${trends?.previousRunId || 'UNKNOWN'}\``, `- Current run: \`${trends?.currentRunId || 'UNKNOWN'}\``, `- Previous source revision: \`${trends?.sourceRevisions?.previous?.sha || 'UNKNOWN'}\` (${trends?.sourceRevisions?.previous?.status || 'UNKNOWN'})`, `- Current source revision: \`${trends?.sourceRevisions?.current?.sha || 'UNKNOWN'}\` (${trends?.sourceRevisions?.current?.status || 'UNKNOWN'})`, ''];
  if (trends?.contract?.reasons?.length) lines.push('## Comparability contract', '', ...trends.contract.reasons.map((reason) => `- ${escapeMarkdownCell(reason)}`), '');
  const summary = trends?.summary || {};
  lines.push('## Summary', '', `- Matched functions: ${summary.matchedFunctions || 0}`, `- Comparable functions: ${summary.comparableFunctions || 0}`, `- Improved: ${summary.improved || 0}`, `- Degraded: ${summary.degraded || 0}`, `- Unchanged: ${summary.unchanged || 0}`, `- Not comparable: ${summary.notComparable || 0}`, `- Partially not measured: ${summary.partiallyNotMeasured || 0}`, `- Not measured: ${summary.notMeasured || 0}`, `- Added: ${summary.added || 0}`, `- Removed: ${summary.removed || 0}`, '');
  lines.push('## Matched functions', '');
  if (!trends?.functions?.length) lines.push('None recorded.', '');
  else {
    lines.push('| Function | Previous | Current | Status | Metric changes |', '| --- | --- | --- | --- | --- |');
    for (const entry of trends.functions) {
      const functionLabel = escapeMarkdownCell(`${entry.current.path}::${entry.current.functionName}`);
      const previousLines = escapeMarkdownCell(`${entry.previous.startLine}-${entry.previous.endLine}`);
      const currentLines = escapeMarkdownCell(`${entry.current.startLine}-${entry.current.endLine}`);
      const metrics = escapeMarkdownCell(entry.metrics.map((metric) => `${metric.metricId}: ${formatMetricValue(metric.previousValue)} -> ${formatMetricValue(metric.currentValue)} (${metric.status})`).join('; '));
      lines.push(`| ${functionLabel} | ${previousLines} | ${currentLines} | ${escapeMarkdownCell(entry.status)} | ${metrics} |`);
    }
    lines.push('');
  }
  lines.push('## Added functions', '', ...(trends?.addedFunctions?.length ? trends.addedFunctions.map((entry) => `- ${escapeMarkdownCell(`${entry.path}::${entry.functionName} (${entry.functionId})`)}`) : ['None recorded.']), '', '## Removed functions', '', ...(trends?.removedFunctions?.length ? trends.removedFunctions.map((entry) => `- ${escapeMarkdownCell(`${entry.path}::${entry.functionName} (${entry.functionId})`)}`) : ['None recorded.']), '');
  lines.push('## Non-comparable functions', '', ...(trends?.nonComparableFunctions?.length ? trends.nonComparableFunctions.map((entry) => `- ${escapeMarkdownCell(`${entry.path || 'UNKNOWN'}::${entry.functionName || 'UNKNOWN'} — ${entry.reason}`)}`) : ['None recorded.']), '', 'No normative gate, baseline, finding lifecycle or human decision is changed by this trend report.', '');
  return `${lines.join('\n')}\n`;
}

function renderMaintainabilityTrendsTerminal(trends) {
  const summary = trends?.summary || {};
  const lines = ['Maintainability trends', '----------------------', `Status: ${trends?.status || 'NOT_COMPARABLE'}`, `Previous run: ${trends?.previousRunId || 'UNKNOWN'}`, `Current run: ${trends?.currentRunId || 'UNKNOWN'}`, `Matched functions: ${summary.matchedFunctions || 0}`, `Comparable functions: ${summary.comparableFunctions || 0}`, `Improved: ${summary.improved || 0}`, `Degraded: ${summary.degraded || 0}`, `Unchanged: ${summary.unchanged || 0}`, `Not comparable: ${summary.notComparable || 0}`, `Partially not measured: ${summary.partiallyNotMeasured || 0}`, `Not measured: ${summary.notMeasured || 0}`, `Added: ${summary.added || 0}`, `Removed: ${summary.removed || 0}`];
  if (trends?.contract?.reasons?.length) lines.push('', 'Comparability reasons', ...trends.contract.reasons.map((reason) => `- ${reason}`));
  for (const entry of trends?.functions || []) lines.push(`${entry.current.path}::${entry.current.functionName} | ${entry.status} | ${entry.metrics.map((metric) => `${metric.metricId}=${formatMetricValue(metric.previousValue)}->${formatMetricValue(metric.currentValue)}:${metric.status}`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

function importTrendRun(root, runPath) {
  const resolved = path.isAbsolute(runPath) ? runPath : path.resolve(root, runPath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

module.exports = {
  ENGINE_NAME,
  TREND_SCHEMA_VERSION,
  TREND_STATUSES,
  compareMaintainabilityRuns,
  escapeMarkdownCell,
  importTrendRun,
  renderMaintainabilityTrendsMarkdown,
  renderMaintainabilityTrendsTerminal,
};
