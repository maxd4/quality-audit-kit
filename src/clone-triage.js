const crypto = require('node:crypto');

const CATEGORIES = new Set([
  'DUPLICATED_BUSINESS_LOGIC',
  'DUPLICATED_IMPLEMENTATION',
  'SHARED_INFRASTRUCTURE_CANDIDATE',
  'TEST_HARNESS_CANDIDATE',
  'INTENTIONAL_DUPLICATION_CANDIDATE',
  'TEXTUAL_SIMILARITY',
  'REVIEW_REQUIRED',
]);

const RECOMMENDATIONS = new Set([
  'MIGRATE_TO_CANONICAL',
  'CENTRALIZE_OWNER',
  'DELETE_PROVEN',
  'EXTRACT_SHARED_INFRASTRUCTURE',
  'TEST_SHARED_HARNESS',
  'REVIEW_FIRST',
  'INVESTIGATE',
  'KEEP_JUSTIFIED',
  'NO_ACTION_NOISE',
]);

const ACTIONABLE = new Set([
  'MIGRATE_TO_CANONICAL',
  'CENTRALIZE_OWNER',
  'DELETE_PROVEN',
  'EXTRACT_SHARED_INFRASTRUCTURE',
  'TEST_SHARED_HARNESS',
  'INVESTIGATE',
]);

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function jsonKey(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function provenanceKey(finding) {
  const provenance = finding?.provenance || {};
  const revision = provenance.sourceRevision || {};
  return JSON.stringify({
    kind: provenance.kind || 'UNKNOWN',
    reference: provenance.reference || 'UNKNOWN',
    revisionStatus: revision.status || 'UNKNOWN',
    revisionSha: revision.sha || null,
  });
}

function occurrenceKey(occurrence) {
  return [occurrence?.path || 'UNKNOWN', occurrence?.startLine ?? '?', occurrence?.endLine ?? '?'].join(':');
}

function pairKey(left, right) {
  return [occurrenceKey(left), occurrenceKey(right)].sort().join('|');
}

function validRange(occurrence) {
  return Number.isInteger(occurrence?.startLine) && Number.isInteger(occurrence?.endLine)
    && occurrence.startLine >= 1 && occurrence.endLine >= occurrence.startLine;
}

function uniqueOccurrences(findings) {
  const result = new Map();
  for (const finding of findings) {
    for (const occurrence of finding.clone.occurrences || []) {
      const key = occurrenceKey(occurrence);
      if (!result.has(key)) result.set(key, { ...occurrence });
    }
  }
  return [...result.values()].sort((left, right) => occurrenceKey(left).localeCompare(occurrenceKey(right)));
}

function uniquePairs(findings) {
  const result = new Map();
  for (const finding of findings) {
    const occurrences = finding.clone.occurrences || [];
    if (occurrences.length < 2) continue;
    const key = pairKey(occurrences[0], occurrences[1]);
    if (!result.has(key)) result.set(key, { key, findingId: finding.id, occurrences: occurrences.map((item) => ({ ...item })) });
  }
  return [...result.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function lineCoverage(occurrences) {
  const byPath = new Map();
  for (const occurrence of occurrences) {
    if (!validRange(occurrence)) continue;
    const ranges = byPath.get(occurrence.path) || [];
    ranges.push([occurrence.startLine, occurrence.endLine]);
    byPath.set(occurrence.path, ranges);
  }
  let coveredLines = 0;
  const merged = [];
  for (const [filePath, ranges] of byPath.entries()) {
    ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const union = [];
    for (const range of ranges) {
      const previous = union.at(-1);
      if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
      else union.push([...range]);
    }
    for (const [startLine, endLine] of union) coveredLines += endLine - startLine + 1;
    merged.push({ path: filePath, ranges: union, lines: union.reduce((sum, [startLine, endLine]) => sum + endLine - startLine + 1, 0) });
  }
  return { coveredLines, files: merged };
}

function overlapCount(occurrences) {
  let count = 0;
  for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
      const left = occurrences[leftIndex];
      const right = occurrences[rightIndex];
      if (left.path === right.path && validRange(left) && validRange(right) && left.startLine <= right.endLine && right.startLine <= left.endLine) count += 1;
    }
  }
  return count;
}

function decisionForFamily(decisions, findingIds) {
  const records = Array.isArray(decisions) ? decisions : decisions?.decisions;
  if (!Array.isArray(records)) return null;
  return records.find((decision) => findingIds.includes(decision.findingId) && (decision.action || decision.decision) && decision.reason && decision.reviewer) || null;
}

function categoryFromAnnotation(annotation) {
  if (!annotation || !CATEGORIES.has(annotation.category) || !annotation.source || !annotation.evidence) return null;
  return {
    category: annotation.category,
    source: annotation.source,
    evidence: String(annotation.evidence),
  };
}

function recommendationFor(category, decision) {
  const action = decision?.action || decision?.decision;
  if (action === 'KEEP_JUSTIFIED') return 'KEEP_JUSTIFIED';
  if (action === 'FALSE_POSITIVE') return 'NO_ACTION_NOISE';
  if (category === 'DUPLICATED_BUSINESS_LOGIC') return 'CENTRALIZE_OWNER';
  if (category === 'DUPLICATED_IMPLEMENTATION') return 'EXTRACT_SHARED_INFRASTRUCTURE';
  if (category === 'SHARED_INFRASTRUCTURE_CANDIDATE') return 'EXTRACT_SHARED_INFRASTRUCTURE';
  if (category === 'TEST_HARNESS_CANDIDATE') return 'TEST_SHARED_HARNESS';
  if (category === 'TEXTUAL_SIMILARITY') return 'INVESTIGATE';
  if (category === 'INTENTIONAL_DUPLICATION_CANDIDATE') return 'REVIEW_FIRST';
  return 'REVIEW_FIRST';
}

function priorityFor(family, category, decision) {
  const action = decision?.action || decision?.decision;
  if (action === 'KEEP_JUSTIFIED' || action === 'FALSE_POSITIVE') return 'P3';
  if (category === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  const explicitSecurity = family.relatedFindings.some((finding) => finding.planning?.securityConfirmed === true || finding.severity === 'CRITICAL');
  return explicitSecurity ? 'P1' : 'P2';
}

function prudenceFor(family) {
  if (family.relatedFindings.some((finding) => finding.planning?.securityConfirmed === true)) return 'R4';
  return 'REVIEW_REQUIRED';
}

function effortFor(family) {
  if (family.dataAvailability !== 'COMPLETE') return 'NOT_ESTIMABLE';
  if (family.distinctFiles <= 1) return 'LOW';
  if (family.distinctFiles <= 3) return 'MEDIUM';
  return 'HIGH';
}

function buildFamily(group, decisions, annotations) {
  const findings = group.findings;
  const findingIds = findings.map((finding) => finding.id).sort();
  const occurrences = uniqueOccurrences(findings);
  const pairs = uniquePairs(findings);
  const files = [...new Set(occurrences.map((occurrence) => occurrence.path).filter(Boolean))].sort();
  const coverage = lineCoverage(occurrences);
  const completeRanges = occurrences.length > 0 && occurrences.every(validRange);
  const dataAvailability = completeRanges && findings.every((finding) => finding.clone.dataAvailability === 'COMPLETE') ? 'COMPLETE' : occurrences.length ? 'PARTIAL' : 'INSUFFICIENT';
  const relatedFindings = [...new Map(group.allFindings.filter((finding) => finding.engine !== 'jscpd' && files.includes(finding.path)).map((finding) => [finding.id, finding])).values()];
  const familyId = `clone-family:${hash(JSON.stringify({ grouping: group.grouping, scope: group.scope, provenance: group.provenance })).slice(0, 32)}`;
  const annotation = categoryFromAnnotation(annotations?.[familyId]);
  const decision = decisionForFamily(decisions, findingIds);
  const category = annotation?.category || 'REVIEW_REQUIRED';
  const recommendation = recommendationFor(category, decision);
  const family = {
    id: familyId,
    grouping: group.grouping,
    scope: group.scope,
    provenance: group.provenance,
    findingIds,
    pairCount: pairs.length,
    uniqueOccurrenceCount: occurrences.length,
    distinctFiles: files.length,
    files,
    occurrences,
    pairs,
    lineCoverage: { status: completeRanges ? 'MEASURED' : 'NOT_ESTIMABLE', unionLines: completeRanges ? coverage.coveredLines : null, byFile: coverage.files },
    overlapCount: overlapCount(occurrences),
    dataAvailability,
    metrics: {
      reportedLines: [...new Set(findings.map((finding) => finding.clone.metrics?.lines).filter((value) => Number.isFinite(value)))],
      reportedPercentages: [...new Set(findings.map((finding) => finding.clone.metrics?.percentage).filter((value) => Number.isFinite(value)))],
      reportedTokens: [...new Set(findings.map((finding) => finding.clone.metrics?.tokens).filter((value) => Number.isFinite(value)))],
    },
    relatedFindings: relatedFindings.map((finding) => ({ id: finding.id, engine: finding.engine, ruleId: finding.ruleId, path: finding.path, relation: 'SHARED_FILE_ONLY' })),
  };
  family.qualification = {
    category,
    source: annotation?.source || 'DETERMINISTIC_OBSERVATION',
    evidence: annotation?.evidence || 'jscpd demonstrates syntactic similarity only; semantic equivalence and ownership are not established.',
    observations: ['The family is grouped from native jscpd identity or explicit derived pair characteristics.'],
    hypotheses: [],
    conclusions: [],
    approvedDecision: decision ? { action: decision.action || decision.decision, reason: decision.reason, reviewer: decision.reviewer } : null,
  };
  family.benefit = {
    diffusion: family.distinctFiles > 0 ? family.distinctFiles : 'NOT_ESTIMABLE',
    measuredVolume: family.lineCoverage.unionLines === null ? 'NOT_ESTIMABLE' : family.lineCoverage.unionLines,
    sharedResponsibility: 'NOT_ESTIMABLE',
    divergenceRisk: 'NOT_ESTIMABLE',
    mutualizationPotential: 'NOT_ESTIMABLE',
    confidence: 'LOW',
  };
  family.priority = priorityFor(family, category, decision);
  family.prudence = prudenceFor(family);
  family.effort = effortFor(family);
  family.recommendation = recommendation;
  family.promptEligible = ACTIONABLE.has(recommendation) && category !== 'REVIEW_REQUIRED';
  return family;
}

function buildCloneAudit(run, options = {}) {
  const allFindings = Array.isArray(run?.findings) ? run.findings : [];
  const cloneFindings = allFindings.filter((finding) => finding.engine === 'jscpd' && finding.clone && Array.isArray(finding.clone.occurrences));
  const jscpdEngine = (run?.engines || []).find((engine) => engine.name === 'jscpd');
  const diagnostics = [];
  if (allFindings.some((finding) => finding.engine === 'jscpd') && cloneFindings.length === 0) diagnostics.push({ code: 'CLONE_ENRICHMENT_UNAVAILABLE', message: 'The input contains jscpd findings without clone metadata; no family can be safely inferred.' });
  if (!allFindings.some((finding) => finding.engine === 'jscpd')) diagnostics.push({ code: 'CLONE_DATA_UNAVAILABLE', message: 'No jscpd measurement was present; clone conclusions are unavailable.' });
  const groups = new Map();
  for (const finding of cloneFindings) {
    const clone = finding.clone;
    const grouping = clone.grouping || { source: 'UNAVAILABLE', key: finding.id, derived: true };
    const scope = clone.scope || 'UNKNOWN';
    const provenance = provenanceKey(finding);
    const key = JSON.stringify({ grouping, scope, provenance });
    const group = groups.get(key) || { grouping, scope, provenance: JSON.parse(provenance), findings: [], allFindings };
    group.findings.push(finding);
    groups.set(key, group);
  }
  const decisions = options.decisions || run?.decisions || [];
  const annotations = options.annotations || run?.cloneAnnotations || {};
  const families = [...groups.values()].map((group) => buildFamily(group, decisions, annotations)).sort((left, right) => left.id.localeCompare(right.id));
  const prompts = families.filter((family) => family.promptEligible).map((family) => ({
    familyId: family.id,
    fileName: `${family.id.replace(/[^a-z0-9:-]+/gi, '-')}.md`,
    prompt: `Review clone family ${family.id}. Evidence: ${family.qualification.evidence} Files: ${family.files.join(', ')}. Proposed action: ${family.recommendation}. Do not modify code until a human confirms ownership, behavior and tests.`,
  }));
  return {
    schemaVersion: '0.1-draft',
    auditVersion: '0.1-draft',
    status: cloneFindings.length ? (jscpdEngine?.measurementStatus === 'PARTIAL' ? 'PARTIAL' : 'MEASURED') : 'INSUFFICIENT_DATA',
    runId: run?.runId || null,
    source: {
      repository: run?.repository?.name || null,
      runId: run?.runId || null,
      inputScope: run?.inputScope || 'UNKNOWN',
      reproducible: run?.reproducible === true,
      sourceRevisions: [...new Set(cloneFindings.map(provenanceKey))].map((value) => JSON.parse(value)),
    },
    evidenceContext: {
      scanner: jscpdEngine ? { measurementStatus: jscpdEngine.measurementStatus, gateOutcome: jscpdEngine.gateOutcome || 'NOT_EVALUATED', sourceRevision: jscpdEngine.sourceRevision || null } : { measurementStatus: 'NOT_MEASURED', gateOutcome: 'NOT_EVALUATED', sourceRevision: null },
      comparison: run?.comparison ? { status: run.comparison.status || 'UNKNOWN', baselineRunId: run.comparison.baselineRunId || null } : { status: 'NOT_RECORDED', baselineRunId: null },
      history: run?.history ? 'RECORDED' : 'NOT_RECORDED',
      decisions: decisions.length ? 'SUPPLIED' : 'NOT_SUPPLIED',
    },
    counts: { families: families.length, occurrences: families.reduce((sum, family) => sum + family.uniqueOccurrenceCount, 0), pairs: families.reduce((sum, family) => sum + family.pairCount, 0), actionable: prompts.length, incomplete: families.filter((family) => family.dataAvailability !== 'COMPLETE').length },
    diagnostics,
    families,
    prompts,
    summary: 'jscpd similarity is evidence for review, not proof of semantic duplication, common ownership, safe deletion or quantified savings.',
  };
}

function familyLine(family) {
  return `| ${family.id} | ${family.category || family.qualification.category} | ${family.scope} | ${family.distinctFiles} | ${family.uniqueOccurrenceCount} | ${family.pairCount} | ${family.recommendation} | ${family.dataAvailability} |`;
}

function renderCloneMarkdown(audit, options = {}) {
  const families = audit?.families || [];
  const groups = {
    A: families.filter((family) => family.promptEligible),
    B: families.filter((family) => family.qualification.category === 'REVIEW_REQUIRED' && family.dataAvailability !== 'INSUFFICIENT'),
    C: families.filter((family) => ['INTENTIONAL_DUPLICATION_CANDIDATE', 'TEXTUAL_SIMILARITY'].includes(family.qualification.category) || ['KEEP_JUSTIFIED', 'NO_ACTION_NOISE'].includes(family.recommendation)),
    D: families.filter((family) => family.dataAvailability === 'INSUFFICIENT' || family.dataAvailability === 'PARTIAL'),
  };
  const lines = [options.title || '# Clone audit', '', `- Status: \`${audit?.status || 'UNKNOWN'}\``, `- Families: ${audit?.counts?.families || 0}`, `- Unique occurrences: ${audit?.counts?.occurrences || 0}`, `- Unique pairs: ${audit?.counts?.pairs || 0}`, '', 'jscpd similarity is not semantic proof and no gain is estimated without evidence.', ''];
  for (const [letter, title] of [['A', 'Corrections à fort potentiel'], ['B', 'Revue renforcée'], ['C', 'Intentionnels/non actionnables'], ['D', 'Données insuffisantes']]) {
    lines.push(`## ${letter}. ${title}`, '', '| Family | Category | Scope | Files | Occurrences | Pairs | Recommendation | Data |', '| --- | --- | --- | ---: | ---: | ---: | --- | --- |');
    if (!groups[letter].length) lines.push('None recorded.');
    else for (const family of groups[letter]) lines.push(familyLine(family));
    lines.push('');
  }
  lines.push('## E. Synthèse complète', '', ...families.map((family) => `- **${family.id}**: ${family.qualification.category}; ${family.scope}; ${family.uniqueOccurrenceCount} occurrences; coverage=${family.lineCoverage.unionLines ?? 'NOT_ESTIMABLE'}; priority=${family.priority}; prudence=${family.prudence}; effort=${family.effort}.`));
  if (!families.length) lines.push('None recorded.');
  if (audit?.diagnostics?.length) lines.push('', '### Diagnostics', '', ...audit.diagnostics.map((diagnostic) => `- **${diagnostic.code}**: ${diagnostic.message}`));
  lines.push('', 'No automatic agent or source-code change is produced by this audit.', '');
  return `${lines.join('\n')}\n`;
}

module.exports = {
  ACTIONABLE,
  CATEGORIES,
  RECOMMENDATIONS,
  buildCloneAudit,
  renderCloneMarkdown,
};
