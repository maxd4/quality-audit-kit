const crypto = require('node:crypto');
const { sanitizeForExport } = require('./report');

const CATEGORY_ORDER = [
  'SECURITY_CONFIRMED',
  'REGRESSION',
  'CONTRACT_BROKEN',
  'STRUCTURAL_CAUSE',
  'ACTIONABLE_DEBT',
  'SECONDARY_IMPROVEMENT',
  'UNCERTAIN',
];

const CATEGORY_LABELS = {
  SECURITY_CONFIRMED: 'Sécurité confirmée',
  REGRESSION: 'Régression',
  CONTRACT_BROKEN: 'Contrat cassé',
  STRUCTURAL_CAUSE: 'Cause structurelle',
  ACTIONABLE_DEBT: 'Dette actionnable',
  SECONDARY_IMPROVEMENT: 'Amélioration secondaire',
  UNCERTAIN: 'À qualifier',
};

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];
const FACTOR_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeFactor(value) {
  const normalized = normalizeText(value).toUpperCase();
  return FACTOR_ORDER.includes(normalized) ? normalized : 'UNKNOWN';
}

function severity(value) {
  const normalized = normalizeText(value).toUpperCase();
  return SEVERITY_ORDER.includes(normalized) ? normalized : 'UNKNOWN';
}

function severityRank(value) {
  const index = SEVERITY_ORDER.indexOf(severity(value));
  return index < 0 ? SEVERITY_ORDER.length : index;
}

function factorRank(value) {
  const index = FACTOR_ORDER.indexOf(normalizeFactor(value));
  return index < 0 ? FACTOR_ORDER.length : index;
}

function confidence(value) {
  const normalized = normalizeText(value).toUpperCase();
  return ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(normalized) ? normalized : 'UNKNOWN';
}

function confidenceRank(value) {
  return { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 }[confidence(value)];
}

function first(value, keys) {
  for (const source of [value, value?.planning]) {
    for (const key of keys) {
      if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  return undefined;
}

function arrayValue(value, keys) {
  const selected = first(value, keys);
  if (Array.isArray(selected)) return selected.map(normalizeText).filter(Boolean);
  if (selected === undefined || selected === null || selected === '') return [];
  return [normalizeText(selected)].filter(Boolean);
}

function categoryForFinding(finding) {
  const explicit = normalizeText(first(finding, ['planCategory', 'category', 'priorityCategory'])).toUpperCase().replace(/[ -]+/g, '_');
  if (CATEGORY_ORDER.includes(explicit)) return explicit;
  if (first(finding, ['securityConfirmed']) === true || normalizeText(first(finding, ['securityStatus'])).toUpperCase() === 'CONFIRMED') return 'SECURITY_CONFIRMED';
  if (finding.lifecycle === 'REINTRODUCED') return 'REGRESSION';
  if (first(finding, ['contractBroken']) === true || normalizeText(first(finding, ['contractStatus'])).toUpperCase() === 'BROKEN') return 'CONTRACT_BROKEN';
  if (normalizeText(first(finding, ['causeType'])).toUpperCase() === 'STRUCTURAL') return 'STRUCTURAL_CAUSE';
  if (finding.lifecycle === 'NEW' || finding.lifecycle === 'HISTORICAL_ACTIONABLE') return 'ACTIONABLE_DEBT';
  if (finding.lifecycle === 'HISTORICAL_JUSTIFIED') return 'SECONDARY_IMPROVEMENT';
  return 'UNCERTAIN';
}

function commonCauseEvidence(finding) {
  const cause = first(finding, ['commonCauseId', 'causeId', 'rootCauseId', 'planGroupId']);
  const evidence = first(finding, ['commonCauseEvidence', 'causeEvidence', 'rootCauseEvidence', 'planGroupEvidence']);
  const confirmed = first(finding, ['commonCauseConfirmed', 'rootCauseConfirmed', 'planGroupConfirmed']) === true;
  if (!cause || (!evidence && !confirmed)) return null;
  return { id: normalizeText(cause), evidence: normalizeText(evidence) || 'Explicit common-cause confirmation was recorded.' };
}

function responsibilityOf(finding) {
  return normalizeText(first(finding, ['responsibility', 'owner', 'responsibleTeam', 'ownership'])) || 'UNKNOWN';
}

function dependenciesOf(finding) {
  return arrayValue(finding, ['dependsOn', 'dependsOnFindings', 'dependencies']);
}

function findingConfidence(finding, groupEvidence, run) {
  const explicit = confidence(first(finding, ['confidence', 'evidenceConfidence', 'planConfidence']));
  if (explicit !== 'UNKNOWN') return explicit;
  if (groupEvidence) return 'HIGH';
  if (run.comparison?.compatible && finding.lifecycle !== 'UNCLASSIFIED') return 'MEDIUM';
  return 'UNKNOWN';
}

function collectConsumers(findings) {
  const named = [...new Set(findings.flatMap((finding) => arrayValue(finding, ['consumers', 'consumer', 'consumerPaths'])))].sort();
  const counts = findings.map((finding) => Number(first(finding, ['consumerCount', 'consumersCount']))).filter((value) => Number.isInteger(value) && value >= 0);
  const count = named.length || (counts.length ? Math.max(...counts) : 0);
  return { known: named.length > 0 || counts.length > 0, names: named, count };
}

function factorFor(findings, keys) {
  const values = findings.map((finding) => normalizeFactor(first(finding, keys))).filter((value) => value !== 'UNKNOWN');
  if (!values.length) return 'UNKNOWN';
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : 'UNKNOWN';
}

function decisionMap(decisions) {
  const latest = new Map();
  for (const decision of decisions?.decisions || []) latest.set(decision.findingId, decision);
  return latest;
}

function staleMap(staleDecisions) {
  return new Map((staleDecisions || []).map((decision) => [decision.findingId, decision]));
}

function findingDisposition(finding, decisions, staleDecisions) {
  const decision = decisions.get(finding.id);
  const stale = staleDecisions.get(finding.id);
  if (stale?.status === 'STALE') return { active: true, reason: `Decision ${decision?.decision || 'UNKNOWN'} is stale: ${(stale.reasons || []).join(' ') || 'review is required.'}` };
  if (first(finding, ['falsePositive']) === true || decision?.decision === 'FALSE_POSITIVE') return { active: false, status: 'FALSE_POSITIVE', reason: 'Explicit false-positive decision is still active.' };
  if (first(finding, ['justified']) === true || decision?.decision === 'KEEP_JUSTIFIED' || finding.lifecycle === 'HISTORICAL_JUSTIFIED') return { active: false, status: 'JUSTIFIED', reason: 'Explicit justification is still active and is not stale.' };
  return { active: true, decision: decision?.decision || null };
}

function groupFindings(run, decisions, staleDecisions) {
  const active = [];
  const excluded = [];
  const warnings = [];
  for (const finding of run.findings || []) {
    const disposition = findingDisposition(finding, decisions, staleDecisions);
    if (!disposition.active) {
      excluded.push({ findingId: finding.id, status: disposition.status, reason: disposition.reason });
      continue;
    }
    if (finding.measurementStatus && finding.measurementStatus !== 'MEASURED') {
      excluded.push({ findingId: finding.id, status: 'UNMEASURED', reason: `Finding measurement status is ${finding.measurementStatus}; no correction is planned from an incomplete measure.` });
      warnings.push(`Finding ${finding.id} is not fully measured.`);
      continue;
    }
    const cause = commonCauseEvidence(finding);
    active.push({ finding, cause, category: categoryForFinding(finding), responsibility: responsibilityOf(finding) });
  }

  const groups = new Map();
  for (const item of active) {
    const key = item.cause ? `cause:${item.category}:${item.cause.id}` : `finding:${item.finding.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return { active, excluded, warnings, groups };
}

function groupToLot(items, run) {
  const findings = items.map((item) => item.finding).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const cause = items[0].cause;
  const causeEvidenceValues = [...new Set(items.map((item) => item.cause?.evidence).filter(Boolean))];
  const contradictoryCauseEvidence = Boolean(cause && causeEvidenceValues.length > 1);
  const category = items[0].category;
  const responsibilityValues = [...new Set(items.map((item) => item.responsibility))];
  const responsibility = responsibilityValues.length === 1 ? responsibilityValues[0] : 'UNKNOWN';
  const consumers = collectConsumers(findings);
  const confidenceValue = findings.reduce((best, finding) => {
    const current = findingConfidence(finding, cause, run);
    return confidenceRank(current) < confidenceRank(best) ? current : best;
  }, 'UNKNOWN');
  const severityValue = findings.reduce((best, finding) => severityRank(finding.severity) < severityRank(best) ? severity(finding.severity) : best, 'UNKNOWN');
  const files = [...new Set(findings.map((finding) => normalizeText(finding.path)).filter(Boolean))].sort();
  const causeText = cause ? `The findings declare common cause ${cause.id}. Evidence: ${causeEvidenceValues.join(' | ')}` : 'No substantiated common cause was declared; this lot is intentionally limited to one finding.';
  const relationEvidence = cause ? causeEvidenceValues.map((evidence) => ({ type: 'COMMON_CAUSE', reference: cause.id, outcome: evidence })) : [{ type: 'SINGLE_FINDING', reference: findings[0].id, outcome: 'No cross-finding relation inferred.' }];
  const key = stableJson({ category, cause: cause?.id || null, findings: findings.map((finding) => finding.id) });
  const id = `lot-${sha256(key).slice(0, 16)}`;
  const invariants = [
    'Do not change the baseline, ratchet policy or triage decisions implicitly.',
    'Preserve finding IDs, provenance and the distinction between measured, failed and unmeasured evidence.',
    'Do not modify files outside the approved file list without explicit review.',
    'Do not install dependencies or publish secrets, source excerpts or sensitive paths.',
  ];
  const checks = [
    `Re-run the relevant scanner(s) for ${findings.map((finding) => finding.engine).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).sort().join(', ') || 'UNKNOWN'} against the same scope.`,
    `Confirm that the planned findings are resolved or deliberately reclassified without losing provenance: ${findings.map((finding) => finding.id).join(', ')}.`,
  ];
  const detectedScripts = [...new Set((run.discovery?.scripts || []).map((script) => normalizeText(script)).filter(Boolean))].sort();
  if (detectedScripts.length) checks.push(`Run detected repository checks by name after the change: ${detectedScripts.join(', ')}.`);
  const objective = category === 'UNCERTAIN'
    ? 'Qualify the uncertain finding and its proposed correction without making an unsupported change.'
    : `Correct ${CATEGORY_LABELS[category].toLowerCase()} represented by ${findings.length} finding${findings.length === 1 ? '' : 's'}.`;
  const stopCondition = 'Stop if the common cause is not confirmed by the repository, a verification fails, a required consumer is unknown, or the change would require altering policy/baseline/decisions.';
  return {
    id,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    title: `${CATEGORY_LABELS[category]} — ${responsibility}${cause ? ` — ${cause.id}` : ` — ${findings[0].id}`}`,
    status: category === 'UNCERTAIN' || contradictoryCauseEvidence ? 'NEEDS_TRIAGE' : 'READY',
    findings: findings.map((finding) => ({
      id: finding.id,
      engine: finding.engine,
      ruleId: finding.ruleId,
      path: finding.path,
      severity: finding.severity,
      lifecycle: finding.lifecycle,
      message: finding.message,
      provenance: finding.provenance,
    })),
    files,
    responsibility: { value: responsibility, evidence: responsibility === 'UNKNOWN' ? 'No explicit responsibility was recorded.' : 'Responsibility was explicitly recorded on the finding(s).' },
    cause: { value: cause?.id || null, evidence: causeText, relationEvidence },
    dependencies: [],
    dependencyReasons: [],
    unresolvedDependencies: [],
    factors: {
      severity: severityValue,
      findingCount: findings.length,
      confidence: confidenceValue,
      consumers,
      estimatedCost: factorFor(findings, ['estimatedCost', 'cost', 'implementationCost']),
      changeRisk: factorFor(findings, ['changeRisk', 'modificationRisk', 'risk']),
    },
    rationale: [
      `Category ordering is ${CATEGORY_LABELS[category].toLowerCase()}.`,
      causeText,
      `Severity considered: ${severityValue}; findings in lot: ${findings.length}; confidence: ${confidenceValue}.`,
      consumers.known ? `Consumers considered: ${consumers.count}${consumers.names.length ? ` (${consumers.names.join(', ')})` : ''}.` : 'Consumers are UNKNOWN and were not invented.',
      `Estimated cost: ${factorFor(findings, ['estimatedCost', 'cost', 'implementationCost'])}; modification risk: ${factorFor(findings, ['changeRisk', 'modificationRisk', 'risk'])}.`,
      ...(contradictoryCauseEvidence ? ['Common-cause evidence is contradictory; human review is required before correction.'] : []),
    ],
    invariants,
    checks,
    stopCondition,
    relationEvidence,
  };
}

function compareLots(left, right) {
  const categoryDifference = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
  if (categoryDifference) return categoryDifference;
  const severityDifference = severityRank(right.factors.severity) - severityRank(left.factors.severity);
  if (severityDifference) return severityDifference;
  const confidenceDifference = confidenceRank(left.factors.confidence) - confidenceRank(right.factors.confidence);
  if (confidenceDifference) return confidenceDifference;
  if (right.factors.findingCount !== left.factors.findingCount) return right.factors.findingCount - left.factors.findingCount;
  if (right.factors.consumers.count !== left.factors.consumers.count) return right.factors.consumers.count - left.factors.consumers.count;
  const riskDifference = factorRank(left.factors.changeRisk) - factorRank(right.factors.changeRisk);
  if (riskDifference) return riskDifference;
  const costDifference = factorRank(left.factors.estimatedCost) - factorRank(right.factors.estimatedCost);
  if (costDifference) return costDifference;
  return left.id.localeCompare(right.id);
}

function resolveDependencies(lots, activeItems) {
  const findingToLot = new Map();
  const causeToLot = new Map();
  for (const lot of lots) {
    for (const finding of lot.findings) findingToLot.set(finding.id, lot.id);
    if (lot.cause.value) causeToLot.set(lot.cause.value, lot.id);
  }
  const allFindingMetadata = new Map(activeItems.map((item) => [item.finding.id, item.finding]));
  for (const lot of lots) {
    const dependencyIds = new Set();
    const reasons = [];
    for (const finding of lot.findings) {
      for (const dependency of dependenciesOf(allFindingMetadata.get(finding.id))) {
        const dependencyLot = findingToLot.get(dependency);
        if (dependencyLot && dependencyLot !== lot.id) {
          dependencyIds.add(dependencyLot);
          reasons.push(`${finding.id} explicitly depends on finding ${dependency}.`);
        } else if (!dependencyLot) {
          lot.unresolvedDependencies.push(dependency);
          reasons.push(`${finding.id} declares an unknown dependency ${dependency}.`);
        }
      }
      const dependencyCause = first(allFindingMetadata.get(finding.id), ['dependsOnCauseId', 'dependsOnRootCauseId']);
      if (dependencyCause) {
        const dependencyLot = causeToLot.get(normalizeText(dependencyCause));
        if (dependencyLot && dependencyLot !== lot.id) {
          dependencyIds.add(dependencyLot);
          reasons.push(`${finding.id} depends on common cause ${dependencyCause}.`);
        } else if (!dependencyLot) {
          lot.unresolvedDependencies.push(normalizeText(dependencyCause));
          reasons.push(`${finding.id} declares an unknown cause dependency ${dependencyCause}.`);
        }
      }
    }
    lot.dependencies = [...dependencyIds].sort();
    lot.unresolvedDependencies = [...new Set(lot.unresolvedDependencies)].sort();
    lot.dependencyReasons = [...new Set(reasons)].sort();
    if (lot.unresolvedDependencies.length) lot.status = 'NEEDS_TRIAGE';
  }
}

function findCycles(lots) {
  const byId = new Map(lots.map((lot) => [lot.id, lot]));
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push(stack.slice(start).concat(id));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id); stack.push(id);
    for (const dependency of byId.get(id)?.dependencies || []) visit(dependency);
    stack.pop(); visiting.delete(id); visited.add(id);
  }
  for (const lot of lots) visit(lot.id);
  return cycles.map((cycle) => [...new Set(cycle)].sort());
}

function orderLots(lots) {
  const byId = new Map(lots.map((lot) => [lot.id, lot]));
  const indegree = new Map(lots.map((lot) => [lot.id, lot.dependencies.length]));
  const dependents = new Map(lots.map((lot) => [lot.id, []]));
  for (const lot of lots) for (const dependency of lot.dependencies) if (dependents.has(dependency)) dependents.get(dependency).push(lot.id);
  const ready = lots.filter((lot) => indegree.get(lot.id) === 0).sort(compareLots);
  const ordered = [];
  while (ready.length) {
    const current = ready.shift();
    const lotId = current.id;
    ordered.push(current);
    for (const dependent of dependents.get(lotId) || []) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) ready.push(byId.get(dependent));
    }
    ready.sort(compareLots);
  }
  const remaining = lots.filter((lot) => !ordered.some((item) => item.id === lot.id)).sort(compareLots);
  return ordered.concat(remaining);
}

function renderCodexPrompt(plan, lot, priority) {
  const findingLines = lot.findings.map((finding) => `- ${finding.id} — ${finding.engine}/${finding.ruleId} — ${finding.severity} — ${finding.path} — ${finding.lifecycle}: ${finding.message}`).join('\n');
  return [
    `# Codex correction prompt — ${lot.id}`,
    '',
    'You are preparing one bounded correction lot for Quality Audit Kit.',
    `Repository: ${plan.repository.name}`,
    `Run: ${plan.runId}`,
    `Plan: ${plan.planId}`,
    `Priority: ${priority}`,
    `Category: ${lot.categoryLabel}`,
    '',
    '## Objective',
    '',
    lot.objective,
    '',
    '## Evidence and findings',
    '',
    findingLines,
    '',
    `Responsibility: ${lot.responsibility.value}`,
    `Cause evidence: ${lot.cause.evidence}`,
    `Files approved for inspection/change: ${lot.files.length ? lot.files.join(', ') : 'UNKNOWN'}`,
    '',
    '## Invariants',
    '',
    ...lot.invariants.map((item) => `- ${item}`),
    '',
    '## Verification',
    '',
    ...lot.checks.map((item) => `- ${item}`),
    '',
    '## Stop condition',
    '',
    lot.stopCondition,
    '',
    'Do not claim completion if a required file, consumer, test or source revision is UNKNOWN. Report the exact evidence and leave the lot unchanged when the stop condition is reached.',
    '',
  ].join('\n');
}

function buildPlan(run, options = {}) {
  if (!run || typeof run !== 'object' || !run.runId || !run.repository?.name || !Array.isArray(run.findings)) throw new Error('plan input must be an audit run with runId, repository and findings.');
  run = sanitizeForExport(run);
  const decisions = decisionMap(options.decisions);
  const staleDecisions = staleMap(options.staleDecisions || run.comparison?.staleDecisions);
  const grouped = groupFindings(run, decisions, staleDecisions);
  const lots = [...grouped.groups.values()].map((items) => groupToLot(items, run));
  resolveDependencies(lots, grouped.active);
  const cycles = findCycles(lots);
  const cycleMembers = new Set(cycles.flat());
  for (const lot of lots) if (cycleMembers.has(lot.id)) {
    lot.status = 'CYCLE_REQUIRES_REVIEW';
    lot.rationale.push('This lot participates in a dependency cycle; no silent dependency order is claimed.');
  }
  const ordered = orderLots(lots);
  ordered.forEach((lot, index) => { lot.priority = index + 1; lot.objective = lot.category === 'UNCERTAIN' ? 'Qualify the uncertain finding and its proposed correction without making an unsupported change.' : `Correct ${lot.categoryLabel.toLowerCase()} represented by ${lot.findings.length} finding${lot.findings.length === 1 ? '' : 's'}.`; lot.prompt = renderCodexPrompt({ repository: run.repository, runId: run.runId, planId: 'pending' }, lot, index + 1); });
  const identity = stableJson({ runId: run.runId, findings: ordered.map((lot) => ({ id: lot.id, category: lot.category, findings: lot.findings.map((finding) => finding.id), dependencies: lot.dependencies })) });
  const planId = `plan-${sha256(identity).slice(0, 16)}`;
  for (const lot of ordered) lot.prompt = renderCodexPrompt({ repository: run.repository, runId: run.runId, planId }, lot, lot.priority);
  const measurementFailures = (run.engines || []).filter((engine) => engine.measurementStatus !== 'MEASURED').map((engine) => ({ engine: engine.name, status: engine.measurementStatus, diagnostic: engine.diagnostic || 'No diagnostic recorded.' }));
  const status = cycles.length ? 'NEEDS_REVIEW' : measurementFailures.length ? 'BLOCKED_BY_MEASUREMENT' : ordered.some((lot) => lot.status === 'NEEDS_TRIAGE') ? 'NEEDS_TRIAGE' : ordered.length ? 'READY' : 'NO_ACTIONABLE_FINDINGS';
  const plan = {
    schemaVersion: '0.1-draft',
    planVersion: '0.1-draft',
    planType: 'QUALITY_CORRECTION_PLAN',
    planId,
    runId: run.runId,
    repository: clone(run.repository),
    inputScope: run.inputScope || 'UNKNOWN',
    reproducible: run.reproducible === true,
    status,
    ordering: {
      rule: 'category, severity, confidence, finding count, known consumers, change risk, estimated cost, stable lot ID',
      categories: CATEGORY_ORDER.map((category, index) => ({ rank: index + 1, category, label: CATEGORY_LABELS[category] })),
      noOpaqueScore: true,
    },
    measurementFailures,
    warnings: [...grouped.warnings, ...(run.comparison?.compatible === false ? ['The run is not compatible with its comparison context; historical claims are not used as correction evidence.'] : [])],
    excludedFindings: grouped.excluded.sort((left, right) => left.findingId.localeCompare(right.findingId)),
    dependencyCycles: cycles,
    lots: ordered,
    prompts: ordered.map((lot) => ({ lotId: lot.id, priority: lot.priority, category: lot.category, fileName: `${String(lot.priority).padStart(3, '0')}-${lot.id}-codex.md`, content: lot.prompt })),
  };
  return plan;
}

function renderPlanMarkdown(plan) {
  const lines = [
    '# Quality Audit Kit correction plan', '',
    `- Plan: \`${plan.planId}\``, `- Run: \`${plan.runId}\``, `- Repository: \`${plan.repository.name}\``, `- Status: \`${plan.status}\``,
    '', 'No opaque aggregate score is used. Order is explained by category, severity, confidence, finding count, known consumers, change risk, cost and stable lot ID.', '',
    '## Measurement and uncertainty', '',
  ];
  if (plan.measurementFailures.length) for (const failure of plan.measurementFailures) lines.push(`- **${failure.engine}**: ${failure.status} — ${failure.diagnostic}`);
  else lines.push('- No measurement failures recorded.');
  for (const warning of plan.warnings) lines.push(`- Warning: ${warning}`);
  lines.push('', '## Dependency cycles', '');
  if (plan.dependencyCycles.length) for (const cycle of plan.dependencyCycles) lines.push(`- ${cycle.join(' -> ')} -> ${cycle[0]}`);
  else lines.push('- None detected.');
  lines.push('', '## Correction lots', '');
  for (const lot of plan.lots) {
    lines.push(`### ${lot.priority}. ${lot.title}`, '', `- ID: \`${lot.id}\``, `- Category: ${lot.categoryLabel}`, `- Status: ${lot.status}`, `- Findings: ${lot.findings.map((finding) => `\`${finding.id}\``).join(', ')}`, `- Files: ${lot.files.length ? lot.files.map((file) => `\`${file}\``).join(', ') : 'UNKNOWN'}`, `- Dependencies: ${lot.dependencies.length ? lot.dependencies.map((dependency) => `\`${dependency}\``).join(', ') : 'none'}`, `- Responsibility: ${lot.responsibility.value}`, `- Cause: ${lot.cause.evidence}`, `- Factors: severity=${lot.factors.severity}; findings=${lot.factors.findingCount}; confidence=${lot.factors.confidence}; consumers=${lot.factors.consumers.known ? lot.factors.consumers.count : 'UNKNOWN'}; risk=${lot.factors.changeRisk}; cost=${lot.factors.estimatedCost}`, '', 'Rationale:', ...lot.rationale.map((reason) => `- ${reason}`), '', 'Invariants:', ...lot.invariants.map((invariant) => `- ${invariant}`), '', 'Verification:', ...lot.checks.map((check) => `- ${check}`), '', `Stop: ${lot.stopCondition}`, '', '#### Codex prompt', '', '```text', lot.prompt.trim(), '```', '');
  }
  lines.push('## Excluded findings', '');
  if (!plan.excludedFindings.length) lines.push('- None.');
  else for (const excluded of plan.excludedFindings) lines.push(`- \`${excluded.findingId}\`: ${excluded.status} — ${excluded.reason}`);
  return `${lines.join('\n')}\n`;
}

function nextLot(plan) {
  if (plan.dependencyCycles?.length) return { status: 'NEEDS_REVIEW', lot: null, reason: 'Dependency cycle requires explicit review before any correction lot is selected.' };
  if (plan.measurementFailures?.length) return { status: 'BLOCKED_BY_MEASUREMENT', lot: null, reason: 'One or more scanners are failed, skipped or unmeasured; no correction lot is selected as if the audit were complete.' };
  const blocked = new Set(plan.lots.filter((lot) => lot.status !== 'READY').map((lot) => lot.id));
  const candidate = plan.lots.find((lot) => lot.status === 'READY' && lot.dependencies.every((dependency) => !blocked.has(dependency)));
  if (candidate) return { status: 'READY', lot: candidate, reason: 'Highest-priority ready lot without an unresolved predecessor.' };
  const triage = plan.lots.find((lot) => lot.status === 'NEEDS_TRIAGE');
  if (triage) return { status: 'NEEDS_TRIAGE', lot: triage, reason: 'The next lot needs human qualification before a correction is safe.' };
  return { status: plan.status, lot: null, reason: plan.dependencyCycles.length ? 'Dependency cycle requires explicit review.' : 'No executable correction lot is currently available.' };
}

module.exports = { CATEGORY_LABELS, CATEGORY_ORDER, buildPlan, nextLot, renderCodexPrompt, renderPlanMarkdown };
