const DECISIONS = ['FIX', 'DEFER', 'KEEP_JUSTIFIED', 'FALSE_POSITIVE'];
const BLOCKING_SEVERITIES = ['HIGH', 'CRITICAL'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePolicy(rawPolicy = {}) {
  const blockingSeverities = Array.isArray(rawPolicy.blockingSeverities)
    ? [...new Set(rawPolicy.blockingSeverities.map((value) => String(value).toUpperCase()))]
    : BLOCKING_SEVERITIES;
  const maxNewBlockingFindings = rawPolicy.maxNewBlockingFindings === null || rawPolicy.maxNewBlockingFindings === undefined
    ? 0
    : Number(rawPolicy.maxNewBlockingFindings);
  const maxMeasuredFindings = rawPolicy.maxMeasuredFindings === null || rawPolicy.maxMeasuredFindings === undefined
    ? null
    : Number(rawPolicy.maxMeasuredFindings);
  if (!blockingSeverities.every((value) => ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value))) {
    throw new Error('quality.ratchet.blockingSeverities contains an unsupported severity.');
  }
  if (!Number.isInteger(maxNewBlockingFindings) || maxNewBlockingFindings < 0) {
    throw new Error('quality.ratchet.maxNewBlockingFindings must be a non-negative integer or null.');
  }
  if (maxMeasuredFindings !== null && (!Number.isInteger(maxMeasuredFindings) || maxMeasuredFindings < 0)) {
    throw new Error('quality.ratchet.maxMeasuredFindings must be a non-negative integer or null.');
  }
  return { blockingSeverities, maxNewBlockingFindings, maxMeasuredFindings };
}

function sourceRevisionForEngine(engine) {
  return engine?.sourceRevision;
}

function isVerifiedRevision(revision) {
  return revision?.status === 'VERIFIED' && /^[a-f0-9]{40}$/i.test(String(revision.sha || ''));
}

function assessMeasuredRun(run, label = 'run') {
  const reasons = [];
  if (!run || typeof run !== 'object') reasons.push(`${label} is not a JSON object.`);
  if (!run?.schemaVersion) reasons.push(`${label} has no schemaVersion.`);
  if (!run?.repository?.name) reasons.push(`${label} has no repository name.`);
  if (!Array.isArray(run?.engines) || run.engines.length === 0) reasons.push(`${label} has no engines.`);
  if (!Array.isArray(run?.findings)) reasons.push(`${label} has no findings array.`);

  const engineNames = new Set();
  for (const engine of run?.engines || []) {
    if (engine.gateRelevant === false) continue;
    if (engineNames.has(engine.name)) reasons.push(`${label} contains duplicate engine ${engine.name}.`);
    engineNames.add(engine.name);
    if (engine.measurementStatus !== 'MEASURED') reasons.push(`${label} engine ${engine.name} is ${engine.measurementStatus}, not MEASURED.`);
    if (engine.gateOutcome === 'NOT_EVALUATED') reasons.push(`${label} engine ${engine.name} was not evaluated.`);
    if (!isVerifiedRevision(sourceRevisionForEngine(engine))) reasons.push(`${label} engine ${engine.name} lacks a VERIFIED source revision.`);
  }

  const findingIds = new Set();
  for (const finding of run?.findings || []) {
    if (findingIds.has(finding.id)) reasons.push(`${label} contains duplicate finding ID ${finding.id}.`);
    findingIds.add(finding.id);
    if (finding.measurementStatus !== 'MEASURED') reasons.push(`${label} finding ${finding.id} is not MEASURED.`);
    if (!isVerifiedRevision(finding.provenance?.sourceRevision)) reasons.push(`${label} finding ${finding.id} lacks a VERIFIED source revision.`);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    engineNames: [...engineNames].sort(),
    findingIds,
  };
}

function compatibility(baselineRun, currentRun) {
  const baseline = assessMeasuredRun(baselineRun, 'baseline');
  const current = assessMeasuredRun(currentRun, 'current run');
  const reasons = [...baseline.reasons, ...current.reasons];
  if (baselineRun?.schemaVersion !== currentRun?.schemaVersion) reasons.push('schemaVersion differs.');
  if (baselineRun?.repository?.name !== currentRun?.repository?.name) reasons.push('repository name differs.');
  if (baselineRun?.inputScope !== currentRun?.inputScope) reasons.push('inputScope differs.');
  if (baseline.engineNames.join('|') !== current.engineNames.join('|')) reasons.push('measured engine set differs.');
  return {
    compatible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    baseline,
    current,
  };
}

function comparisonKey(finding) {
  let message = String(finding?.message || '').toLowerCase();
  const knownPaths = [finding?.path, finding?.rawReference].filter(Boolean).map((value) => String(value).replace(/\\/g, '/'));
  for (const knownPath of knownPaths) message = message.split(knownPath.toLowerCase()).join('<path>');
  message = message
    .replace(/\b(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\b/gi, '<path>')
    .replace(/\b\d+(?:\.\d+)?%\b/g, '<percent>')
    .replace(/\bline\s+\d+\b/gi, 'line <number>')
    .replace(/\s+/g, ' ')
    .trim();
  return [finding?.engine || '', finding?.ruleId || '', message].join('|');
}

function indexFindings(findings) {
  const byId = new Map();
  const byKey = new Map();
  for (const finding of findings || []) {
    byId.set(finding.id, finding);
    const key = comparisonKey(finding);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(finding);
  }
  return { byId, byKey };
}

function matchFinding(finding, index, usedIds = new Set()) {
  const exact = index.byId.get(finding.id);
  if (exact && !usedIds.has(exact.id)) return { finding: exact, matchedBy: 'ID' };
  const candidates = (index.byKey.get(comparisonKey(finding)) || []).filter((candidate) => !usedIds.has(candidate.id));
  if (candidates.length === 1) return { finding: candidates[0], matchedBy: 'COMPARISON_KEY' };
  return null;
}

function latestDecisions(bundle) {
  const latest = new Map();
  for (const decision of bundle?.decisions || []) latest.set(decision.findingId, decision);
  return latest;
}

function decisionDisposition(decision, stale) {
  if (stale) return 'ACTIONABLE';
  if (decision?.decision === 'KEEP_JUSTIFIED' || decision?.decision === 'FALSE_POSITIVE') return 'JUSTIFIED';
  return 'ACTIONABLE';
}

function historyEntries(baselineRun) {
  const entries = Array.isArray(baselineRun?.baseline?.history) ? baselineRun.baseline.history : [];
  return [...entries, baselineRun].filter((entry) => entry && Array.isArray(entry.findings));
}

function todayDate(value) {
  return value || new Date().toISOString().slice(0, 10);
}

function evaluateDecisionStaleness(decisionsBundle, currentRun, baselineRun, comparisonResult, today = todayDate()) {
  const latest = latestDecisions(decisionsBundle);
  const historical = historyEntries(baselineRun);
  const result = [];
  for (const decision of latest.values()) {
    const currentFinding = (currentRun?.findings || []).find((finding) => finding.id === decision.findingId);
    const baselineFinding = (baselineRun?.findings || []).find((finding) => finding.id === decision.findingId);
    const historicalFinding = historical.some((entry) => entry.findings.some((finding) => finding.id === decision.findingId));
    const reasons = [];
    const completed = !currentFinding && (decision.decision === 'FIX' || decision.decision === 'FALSE_POSITIVE') && (baselineFinding || historicalFinding);
    if (decision.reviewAfter && String(decision.reviewAfter) <= today && !completed) reasons.push('reviewAfter has elapsed.');
    if (!currentFinding && !baselineFinding && !historicalFinding) reasons.push('finding is absent from the known audit history.');
    if (baselineFinding && !currentFinding && (decision.decision === 'KEEP_JUSTIFIED' || decision.decision === 'DEFER')) {
      reasons.push('the justified/actionable finding is absent from the current complete measurement.');
    }
    const moved = comparisonResult?.matches?.find((match) => match.baselineFindingId === decision.findingId && match.matchedBy !== 'ID');
    if (moved) reasons.push('the finding matched only after its identity or file scope changed.');
    const status = reasons.length ? 'STALE' : completed ? 'SATISFIED' : 'ACTIVE';
    result.push({
      findingId: decision.findingId,
      decision: decision.decision,
      status,
      reasons,
      reviewedRevision: decision.reviewedRevision,
      evidence: clone(decision.evidence),
    });
  }
  return result;
}

function policyRelaxations(baselinePolicy, currentPolicy) {
  const baseline = normalizePolicy(baselinePolicy || {});
  const current = normalizePolicy(currentPolicy || {});
  const reasons = [];
  if (current.maxNewBlockingFindings > baseline.maxNewBlockingFindings) reasons.push('maxNewBlockingFindings was increased.');
  if (baseline.maxMeasuredFindings !== null && (current.maxMeasuredFindings === null || current.maxMeasuredFindings > baseline.maxMeasuredFindings)) {
    reasons.push('maxMeasuredFindings was increased or made unlimited.');
  }
  const baselineSeverities = new Set(baseline.blockingSeverities);
  if (baseline.blockingSeverities.some((severity) => !current.blockingSeverities.includes(severity))) {
    reasons.push('a previously blocking severity was removed from the policy.');
  }
  return { relaxed: reasons.length > 0, reasons, baseline, current };
}

function evaluateQualityGate(currentRun, baselineRun, currentPolicy, comparison, staleDecisions = []) {
  const policy = normalizePolicy(currentPolicy || {});
  const baselinePolicy = baselineRun?.baseline?.policySnapshot || {};
  const relaxation = policyRelaxations(baselinePolicy, policy);
  const latest = latestDecisions(currentRun?.decisions);
  const decisionStatus = new Map(staleDecisions.map((item) => [item.findingId, item]));
  const newBlockingFindings = (currentRun?.findings || []).filter((finding) => {
    if (!['NEW', 'REINTRODUCED'].includes(finding.lifecycle)) return false;
    if (!policy.blockingSeverities.includes(finding.severity)) return false;
    const state = decisionStatus.get(finding.id);
    const decision = latest.get(finding.id);
    return !(state?.status === 'ACTIVE' && decisionDisposition(decision, false) === 'JUSTIFIED');
  });
  const blockedReasons = [];
  if (newBlockingFindings.length > policy.maxNewBlockingFindings) blockedReasons.push('new blocking findings exceed the configured ceiling.');
  if (policy.maxMeasuredFindings !== null && (currentRun?.findings || []).length > policy.maxMeasuredFindings) blockedReasons.push('measured findings exceed maxMeasuredFindings.');
  if (relaxation.relaxed) blockedReasons.push(...relaxation.reasons);
  if (staleDecisions.some((item) => item.status === 'STALE')) blockedReasons.push('one or more triage decisions are stale.');

  const baselineCount = baselineRun?.findings?.length;
  const currentCount = currentRun?.findings?.length;
  const proposals = [];
  if (Number.isInteger(baselineCount) && Number.isInteger(currentCount) && currentCount < baselineCount) {
    proposals.push({
      type: 'STRICTER_CEILING',
      metric: 'measuredFindings',
      currentValue: currentCount,
      previousValue: baselineCount,
      action: 'EXPLICIT_REVIEW_REQUIRED',
      message: 'Measured improvement may propose a stricter ceiling; no baseline or policy was changed automatically.',
    });
  }
  return {
    status: blockedReasons.length ? 'FAIL' : 'PASS',
    policy,
    blockedReasons,
    newBlockingFindings: newBlockingFindings.map((finding) => ({ id: finding.id, severity: finding.severity, path: finding.path, ruleId: finding.ruleId })),
    proposals,
    policyRelaxation: relaxation,
  };
}

function compareRuns(baselineRun, currentRun, decisionsBundle = {}, policy = {}, options = {}) {
  const checked = compatibility(baselineRun, currentRun);
  if (!checked.compatible) {
    const qualityGate = {
      status: 'NOT_EVALUATED',
      policy: normalizePolicy(policy),
      blockedReasons: [],
      newBlockingFindings: [],
      proposals: [],
      policyRelaxation: { relaxed: false, reasons: [] },
    };
    return {
      status: 'NOT_EVALUATED',
      compatible: false,
      reasons: checked.reasons,
      baselineRunId: baselineRun?.runId || null,
      currentRunId: currentRun?.runId || null,
      matches: [],
      resolved: [],
      staleDecisions: [],
      qualityGate,
    };
  }

  const baselineIndex = indexFindings(baselineRun.findings);
  const historyIndex = indexFindings(historyEntries(baselineRun).flatMap((entry) => entry.findings));
  const decisions = latestDecisions(decisionsBundle);
  const usedBaselineIds = new Set();
  const matches = [];
  const classifiedFindings = [];
  for (const finding of currentRun.findings) {
    const baselineMatch = matchFinding(finding, baselineIndex, usedBaselineIds);
    if (baselineMatch) {
      usedBaselineIds.add(baselineMatch.finding.id);
      const decision = decisions.get(baselineMatch.finding.id) || decisions.get(finding.id);
      const isJustified = decision?.decision === 'KEEP_JUSTIFIED' || decision?.decision === 'FALSE_POSITIVE';
      const lifecycle = isJustified ? 'HISTORICAL_JUSTIFIED' : 'HISTORICAL_ACTIONABLE';
      const classified = { ...finding, lifecycle };
      classifiedFindings.push(classified);
      matches.push({ currentFindingId: finding.id, baselineFindingId: baselineMatch.finding.id, matchedBy: baselineMatch.matchedBy, lifecycle });
      continue;
    }
    const historicalMatch = matchFinding(finding, historyIndex, new Set([...usedBaselineIds]));
    const lifecycle = historicalMatch ? 'REINTRODUCED' : 'NEW';
    classifiedFindings.push({ ...finding, lifecycle });
    if (historicalMatch) matches.push({ currentFindingId: finding.id, historicalFindingId: historicalMatch.finding.id, matchedBy: historicalMatch.matchedBy, lifecycle });
  }
  const resolved = baselineRun.findings
    .filter((finding) => !usedBaselineIds.has(finding.id))
    .map((finding) => ({ findingId: finding.id, lifecycle: 'RESOLVED', finding: clone(finding) }));
  const comparison = {
    status: 'COMPATIBLE',
    compatible: true,
    baselineRunId: baselineRun.runId,
    currentRunId: currentRun.runId,
    matches,
    resolved,
    reasons: [],
  };
  const staleDecisions = evaluateDecisionStaleness(decisionsBundle, { ...currentRun, findings: classifiedFindings }, baselineRun, comparison, options.today);
  const staleIds = new Set(staleDecisions.filter((decision) => decision.status === 'STALE').map((decision) => decision.findingId));
  const finalFindings = classifiedFindings.map((finding) => {
    const match = matches.find((candidate) => candidate.currentFindingId === finding.id);
    if (finding.lifecycle === 'HISTORICAL_JUSTIFIED' && (staleIds.has(finding.id) || staleIds.has(match?.baselineFindingId))) {
      return { ...finding, lifecycle: 'HISTORICAL_ACTIONABLE' };
    }
    return finding;
  });
  const qualityGate = evaluateQualityGate({ ...currentRun, findings: finalFindings, decisions: decisionsBundle }, baselineRun, policy, comparison, staleDecisions);
  return {
    ...comparison,
    classifiedFindings: finalFindings,
    staleDecisions,
    qualityGate,
  };
}

function historySnapshot(run) {
  const snapshot = clone(run);
  delete snapshot.baseline;
  delete snapshot.comparison;
  delete snapshot.qualityGate;
  return snapshot;
}

function createBaseline(run, existingBaseline, policy, now = new Date().toISOString()) {
  const history = [];
  if (existingBaseline?.baseline?.history) history.push(...existingBaseline.baseline.history.map(historySnapshot));
  if (existingBaseline?.runId) history.push(historySnapshot(existingBaseline));
  const deduped = [];
  const seen = new Set();
  for (const entry of history) {
    if (!entry.runId || seen.has(entry.runId)) continue;
    seen.add(entry.runId);
    deduped.push(entry);
  }
  return {
    ...historySnapshot(run),
    baseline: {
      kind: 'QUALITY_BASELINE',
      createdAt: now,
      history: deduped,
      policySnapshot: normalizePolicy(policy),
      ...(existingBaseline?.runId ? { replacedBaselineRunId: existingBaseline.runId } : {}),
    },
  };
}

module.exports = {
  BLOCKING_SEVERITIES,
  DECISIONS,
  assessMeasuredRun,
  compareRuns,
  comparisonKey,
  createBaseline,
  evaluateDecisionStaleness,
  normalizePolicy,
  policyRelaxations,
};
