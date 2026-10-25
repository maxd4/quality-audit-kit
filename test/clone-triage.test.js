const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { buildCloneAudit, renderCloneMarkdown } = require('../src/clone-triage');
const { assessMeasuredRun, compareRuns } = require('../src/history');
const { normalizeJscpd } = require('../src/normalize');
const { buildStructuredReport, renderMarkdown } = require('../src/report');

function runWithFindings(findings) {
  return {
    schemaVersion: '0.1-draft',
    runId: 'clone-test-run',
    repository: { name: 'fixture' },
    inputScope: 'WORKTREE_LIVE',
    reproducible: false,
    engines: [{ name: 'jscpd', measurementStatus: 'MEASURED', gateOutcome: 'INFORMATIVE', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'fixture' }, scope: '.' }],
    findings,
  };
}

function runWithEngine(findings, measurementStatus = 'MEASURED') {
  const run = runWithFindings(findings);
  run.engines[0].measurementStatus = measurementStatus;
  return run;
}

function fixtureFinding(id, firstPath, firstStart, firstEnd, secondPath, secondStart, secondEnd, fingerprint = 'native-1') {
  return {
    id,
    engine: 'jscpd',
    ruleId: 'duplicate-code',
    path: firstPath,
    severity: 'LOW',
    message: 'duplicate',
    lifecycle: 'UNCLASSIFIED',
    measurementStatus: 'MEASURED',
    provenance: { kind: 'REPORT', reference: 'reports/jscpd.json', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'fixture' } },
    clone: {
      scope: firstPath === secondPath ? 'INTRA_FILE' : 'INTER_FILE',
      grouping: { source: 'NATIVE_FINGERPRINT', key: fingerprint, derived: false },
      nativeFingerprint: { value: fingerprint, source: 'REPORT', verified: true },
      occurrences: [
        { side: 'first', path: firstPath, startLine: firstStart, endLine: firstEnd },
        { side: 'second', path: secondPath, startLine: secondStart, endLine: secondEnd },
      ],
      metrics: { lines: 5, percentage: 12, tokens: 20, chars: null, fragment: null },
      dataAvailability: 'COMPLETE',
    },
  };
}

function verifiedCloneRun(findings, runId) {
  const revision = { status: 'VERIFIED', sha: 'c'.repeat(40), basis: 'fixture' };
  const run = runWithFindings(JSON.parse(JSON.stringify(findings)));
  run.runId = runId;
  run.engines[0].sourceRevision = revision;
  for (const finding of run.findings) finding.provenance.sourceRevision = revision;
  return run;
}

test('normalisation preserves exact clone ranges, provenance and native fingerprint', () => {
  const findings = normalizeJscpd('C:/repo', {
    duplicates: [{
      fingerprint: 'jscpd-fp-1',
      lines: 8,
      tokens: 31,
      format: { percentage: 18 },
      firstFile: { name: 'src/a.js', start: 4, end: 11 },
      secondFile: { name: 'src/b.js', start: 20, end: 27 },
    }],
  }, { kind: 'REPORT', reference: 'reports/jscpd.json', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'fixture' } });
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].clone.occurrences, [
    { side: 'first', path: 'src/a.js', startLine: 4, endLine: 11 },
    { side: 'second', path: 'src/b.js', startLine: 20, endLine: 27 },
  ]);
  assert.deepEqual(findings[0].clone.nativeFingerprint, { value: 'jscpd-fp-1', source: 'REPORT', verified: true });
  assert.equal(findings[0].rawReference, 'jscpd://duplicates/0');
  assert.equal(findings.diagnostics.length, 0);
});

test('normalisation gives distinct clone pairs distinct deterministic IDs', () => {
  const report = {
    duplicates: [
      { lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 1, end: 5 }, secondFile: { name: 'src/b.js', start: 20, end: 24 } },
      { lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 10, end: 14 }, secondFile: { name: 'src/b.js', start: 30, end: 34 } },
    ],
  };
  const provenance = { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'VERIFIED', sha: 'a'.repeat(40), basis: 'fixture' } };
  const first = normalizeJscpd('C:/repo', report, provenance);
  const second = normalizeJscpd('C:/repo', { duplicates: [...report.duplicates].reverse() }, provenance);
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map((finding) => finding.id)).size, 2);
  assert.deepEqual(new Set(first.map((finding) => finding.id)), new Set(second.map((finding) => finding.id)));
  assert.notEqual(first[0].clone.identity.pair, first[1].clone.identity.pair);
});

test('strictly repeated pairs are deduplicated while native identities remain distinct', () => {
  const duplicate = { fingerprint: 'native-1', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 1, end: 5 }, secondFile: { name: 'src/b.js', start: 20, end: 24 } };
  const findings = normalizeJscpd('C:/repo', { duplicates: [duplicate, JSON.parse(JSON.stringify(duplicate))] }, { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'fixture' } });
  assert.equal(findings.length, 1);
  assert.equal(findings.diagnostics.filter((diagnostic) => diagnostic.code === 'CLONE_DUPLICATE_DEDUPLICATED').length, 1);
  const differentFingerprint = normalizeJscpd('C:/repo', { duplicates: [duplicate, { ...duplicate, fingerprint: 'native-2' }] }, { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'fixture' } });
  assert.equal(differentFingerprint.length, 2);
  assert.notEqual(differentFingerprint[0].id, differentFingerprint[1].id);
});

test('normalized clone findings remain eligible for historical comparison without duplicate IDs', () => {
  const provenance = { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'VERIFIED', sha: 'b'.repeat(40), basis: 'fixture' } };
  const findings = normalizeJscpd('C:/repo', {
    duplicates: [
      { lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 1, end: 5 }, secondFile: { name: 'src/b.js', start: 20, end: 24 } },
      { lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 10, end: 14 }, secondFile: { name: 'src/b.js', start: 30, end: 34 } },
    ],
  }, provenance);
  const assessment = assessMeasuredRun({ schemaVersion: '0.1-draft', repository: { name: 'fixture' }, engines: [{ name: 'jscpd', measurementStatus: 'MEASURED', sourceRevision: provenance.sourceRevision }], findings }, 'run');
  assert.equal(assessment.reasons.some((reason) => reason.includes('duplicate finding ID')), false);
  assert.equal(assessment.eligible, true);
});

test('native fingerprints preserve unique clone history after a line shift and keep decisions attached to the same clone', () => {
  const provenance = { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'VERIFIED', sha: 'c'.repeat(40), basis: 'fixture' } };
  const initial = {
    duplicates: [
      { fingerprint: 'fp-1', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 10, end: 14 }, secondFile: { name: 'src/b.js', start: 30, end: 34 } },
      { fingerprint: 'fp-2', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 50, end: 54 }, secondFile: { name: 'src/b.js', start: 70, end: 74 } },
    ],
  };
  const shifted = {
    duplicates: [
      { fingerprint: 'fp-2', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 60, end: 64 }, secondFile: { name: 'src/b.js', start: 80, end: 84 } },
      { fingerprint: 'fp-1', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 20, end: 24 }, secondFile: { name: 'src/b.js', start: 40, end: 44 } },
    ],
  };
  const baselineFindings = normalizeJscpd('C:/repo', initial, provenance);
  const currentFindings = normalizeJscpd('C:/repo', shifted, provenance);
  const baselineIds = new Map(baselineFindings.map((finding) => [finding.clone.nativeFingerprint.value, finding.id]));
  const currentIds = new Map(currentFindings.map((finding) => [finding.clone.nativeFingerprint.value, finding.id]));
  assert.deepEqual(currentIds, baselineIds);
  assert.equal(new Set(currentFindings.map((finding) => finding.id)).size, 2);

  // Exercise the historical key even for legacy IDs that included pair ranges.
  for (const finding of baselineFindings) finding.id = `legacy-baseline-${finding.clone.nativeFingerprint.value}`;
  for (const finding of currentFindings) finding.id = `legacy-current-${finding.clone.nativeFingerprint.value}`;
  const baseline = verifiedCloneRun(baselineFindings, 'clone-history-before');
  const current = verifiedCloneRun(currentFindings, 'clone-history-after');
  const result = compareRuns(baseline, current, {
    decisions: [{
      findingId: 'legacy-baseline-fp-1',
      decision: 'KEEP_JUSTIFIED',
      reason: 'Compatibility clone retained by contract.',
      reviewer: 'human',
      reviewedRevision: 'c'.repeat(40),
      evidence: [{ type: 'TEST', reference: 'fixture' }],
    }],
  });
  assert.equal(result.compatible, true);
  assert.equal(result.resolved.length, 0);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(new Set(result.matches.map((match) => match.matchedBy)), new Set(['NATIVE_FINGERPRINT']));
  assert.equal(result.classifiedFindings.find((finding) => finding.clone.nativeFingerprint.value === 'fp-1').lifecycle, 'HISTORICAL_JUSTIFIED');
  assert.equal(result.classifiedFindings.find((finding) => finding.clone.nativeFingerprint.value === 'fp-2').lifecycle, 'HISTORICAL_ACTIONABLE');
  const decision = result.staleDecisions.find((item) => item.findingId === 'legacy-baseline-fp-1');
  assert.equal(decision.status, 'ACTIVE');
  assert.equal(decision.matchedFindingId, 'legacy-current-fp-1');
});

test('duplicate native fingerprints never receive an order-based historical match', () => {
  const report = {
    duplicates: [
      { fingerprint: 'shared-fp', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 1, end: 5 }, secondFile: { name: 'src/b.js', start: 20, end: 24 } },
      { fingerprint: 'shared-fp', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 10, end: 14 }, secondFile: { name: 'src/b.js', start: 30, end: 34 } },
    ],
  };
  const provenance = { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'VERIFIED', sha: 'd'.repeat(40), basis: 'fixture' } };
  const baselineFindings = normalizeJscpd('C:/repo', report, provenance);
  const currentFindings = normalizeJscpd('C:/repo', { duplicates: [...report.duplicates].reverse() }, provenance);
  assert.equal(baselineFindings.length, 2);
  assert.equal(new Set(baselineFindings.map((finding) => finding.id)).size, 2);
  for (const [index, finding] of baselineFindings.entries()) finding.id = `ambiguous-baseline-${index}`;
  for (const [index, finding] of currentFindings.entries()) finding.id = `ambiguous-current-${index}`;
  const result = compareRuns(verifiedCloneRun(baselineFindings, 'ambiguous-before'), verifiedCloneRun(currentFindings, 'ambiguous-after'));
  assert.equal(result.matches.length, 0);
  assert.equal(result.resolved.length, 0);
  assert.equal(result.classifiedFindings.every((finding) => finding.lifecycle === 'UNCLASSIFIED'), true);
  assert.equal(result.diagnostics.every((diagnostic) => diagnostic.code === 'CLONE_HISTORY_NATIVE_FINGERPRINT_AMBIGUOUS'), true);
  const reportRun = verifiedCloneRun(currentFindings, 'ambiguous-after');
  reportRun.findings = result.classifiedFindings;
  const { classifiedFindings, qualityGate, ...serializableComparison } = result;
  reportRun.comparison = serializableComparison;
  reportRun.qualityGate = qualityGate;
  const structured = buildStructuredReport(reportRun);
  assert.equal(structured.comparison.diagnostics.length, 2);
  assert.match(renderMarkdown(reportRun), /CLONE_HISTORY_NATIVE_FINGERPRINT_AMBIGUOUS/);
});

test('incomplete native ranges remain non-comparable instead of becoming a false NEW or RESOLVED pair', () => {
  const report = { duplicates: [{ fingerprint: 'incomplete-fp', lines: 5, tokens: 20, firstFile: { name: 'src/a.js', start: 0, end: 4 }, secondFile: { name: 'src/b.js', start: 20, end: 24 } }] };
  const provenance = { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'VERIFIED', sha: 'e'.repeat(40), basis: 'fixture' } };
  const baselineFindings = normalizeJscpd('C:/repo', report, provenance);
  const currentFindings = normalizeJscpd('C:/repo', report, provenance);
  baselineFindings[0].id = 'incomplete-baseline';
  currentFindings[0].id = 'incomplete-current';
  const result = compareRuns(verifiedCloneRun(baselineFindings, 'incomplete-before'), verifiedCloneRun(currentFindings, 'incomplete-after'));
  assert.equal(result.matches.length, 0);
  assert.equal(result.resolved.length, 0);
  assert.equal(result.classifiedFindings[0].lifecycle, 'UNCLASSIFIED');
  assert.equal(result.diagnostics[0].code, 'CLONE_HISTORY_RANGES_INCOMPLETE');
});

test('normalisation reports incomplete clone paths, ranges and metrics without fabricating them', () => {
  const findings = normalizeJscpd('C:/repo', {
    duplicates: [
      { firstFile: { name: 'src/a.js' }, secondFile: { name: 'src/b.js' } },
      { firstFile: { name: 'src/a.js', start: 8, end: 3 }, secondFile: { name: 'src/b.js', start: 1, end: 2 } },
      { firstFile: { name: 'src/a.js', start: 1, end: 2 } },
    ],
  }, { kind: 'REPORT', reference: 'fixture', sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'fixture' } });
  assert.equal(findings.length, 2);
  assert.ok(findings.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_RANGE_UNAVAILABLE'));
  assert.ok(findings.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_RANGE_INVALID'));
  assert.ok(findings.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_METRICS_UNAVAILABLE'));
  assert.ok(findings.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_PATH_MISSING'));
  assert.equal(findings[0].clone.dataAvailability, 'PARTIAL');
});

test('triage groups native families, removes inverted duplicate pairs and unions overlapping ranges', () => {
  const findings = [
    fixtureFinding('f1', 'src/a.js', 1, 5, 'src/b.js', 10, 14),
    fixtureFinding('f2', 'src/b.js', 10, 14, 'src/a.js', 1, 5),
    fixtureFinding('f3', 'src/a.js', 4, 8, 'src/c.js', 30, 34),
  ];
  const audit = buildCloneAudit(runWithFindings(findings));
  assert.equal(audit.status, 'MEASURED');
  assert.equal(audit.families.length, 1);
  const family = audit.families[0];
  assert.equal(family.pairCount, 2);
  assert.equal(family.uniqueOccurrenceCount, 4);
  assert.equal(family.distinctFiles, 3);
  assert.equal(family.lineCoverage.unionLines, 18);
  assert.equal(family.overlapCount, 1);
  assert.equal(family.qualification.category, 'REVIEW_REQUIRED');
  assert.equal(family.priority, 'REVIEW_REQUIRED');
  assert.equal(family.prudence, 'REVIEW_REQUIRED');
  assert.equal(family.recommendation, 'REVIEW_FIRST');
  assert.equal(audit.prompts.length, 0);
});

test('clone audit propagates the jscpd measurement status and never promotes unmeasured findings', () => {
  const finding = fixtureFinding('status-finding', 'src/a.js', 1, 5, 'src/b.js', 10, 14);
  assert.equal(buildCloneAudit(runWithEngine([finding], 'MEASURED')).status, 'MEASURED');
  assert.equal(buildCloneAudit(runWithEngine([finding], 'PARTIAL')).status, 'PARTIAL');
  for (const status of ['FAILURE', 'NOT_MEASURED', 'SKIPPED_BY_POLICY']) {
    const audit = buildCloneAudit(runWithEngine([finding], status));
    assert.equal(audit.status, status);
    assert.notEqual(audit.status, 'MEASURED');
    assert.equal(audit.evidenceContext.scanner.measurementStatus, status);
    assert.equal(audit.evidenceContext.cloneEvidence, 'FINDINGS_PRESENT_UNVERIFIED');
    assert.equal(audit.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_ENGINE_STATUS_CONTRADICTION'), true);
    assert.equal(audit.families.length, 1);
  }
  const missingEngine = runWithFindings([finding]);
  missingEngine.engines = [];
  const missingAudit = buildCloneAudit(missingEngine);
  assert.equal(missingAudit.status, 'INSUFFICIENT_DATA');
  assert.equal(missingAudit.evidenceContext.scanner.measurementStatus, 'NOT_MEASURED');
  assert.equal(missingAudit.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_ENGINE_MISSING'), true);
});

test('measured zero clones is distinct from a historical run without clone metadata', () => {
  const zero = buildCloneAudit(runWithEngine([]));
  assert.equal(zero.status, 'MEASURED');
  assert.equal(zero.evidenceContext.cloneEvidence, 'MEASURED_ZERO');
  assert.equal(zero.counts.families, 0);
  assert.equal(zero.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_ZERO_FINDINGS'), true);

  const legacy = runWithEngine([{ id: 'legacy-jscpd', engine: 'jscpd', path: 'src/a.js' }]);
  const legacyAudit = buildCloneAudit(legacy);
  assert.equal(legacyAudit.status, 'INSUFFICIENT_DATA');
  assert.equal(legacyAudit.evidenceContext.cloneEvidence, 'UNAVAILABLE');
  assert.equal(legacyAudit.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_ENRICHMENT_UNAVAILABLE'), true);
});

test('measured engine with incomplete clone metadata remains partial', () => {
  const finding = fixtureFinding('partial-finding', 'src/a.js', 1, 5, 'src/b.js', 10, 14);
  finding.clone.dataAvailability = 'PARTIAL';
  const audit = buildCloneAudit(runWithEngine([finding], 'MEASURED'));
  assert.equal(audit.status, 'PARTIAL');
  assert.equal(audit.evidenceContext.cloneEvidence, 'FINDINGS_PRESENT_PARTIAL');
  assert.equal(audit.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_METADATA_INCOMPLETE'), true);
});

test('triage does not merge same-file pairs with different native identities', () => {
  const audit = buildCloneAudit(runWithFindings([
    fixtureFinding('f1', 'src/a.js', 1, 3, 'src/b.js', 10, 12, 'native-1'),
    fixtureFinding('f2', 'src/a.js', 1, 3, 'src/b.js', 10, 12, 'native-2'),
  ]));
  assert.equal(audit.families.length, 2);
});

test('triage keeps human justification separate and never infers a security priority', () => {
  const finding = fixtureFinding('f1', 'test/a.js', 1, 3, 'test/b.js', 10, 12);
  const audit = buildCloneAudit(runWithFindings([finding]), { decisions: [{ findingId: 'f1', decision: 'KEEP_JUSTIFIED', reason: 'Generated compatibility fixture', reviewer: 'human' }] });
  const family = audit.families[0];
  assert.equal(family.recommendation, 'KEEP_JUSTIFIED');
  assert.equal(family.qualification.approvedDecision.action, 'KEEP_JUSTIFIED');
  assert.equal(family.priority, 'P3');
  assert.equal(family.prudence, 'REVIEW_REQUIRED');
  assert.equal(family.promptEligible, false);
});

function familyDecisionFindings() {
  return [
    fixtureFinding('f1', 'src/a.js', 1, 5, 'src/b.js', 10, 14, 'native-family'),
    fixtureFinding('f2', 'src/a.js', 20, 24, 'src/c.js', 30, 34, 'native-family'),
  ];
}

function humanDecision(findingId, decision, reason = `${decision} reason`, reviewer = `reviewer-${findingId}`) {
  return { findingId, decision, reason, reviewer };
}

test('partial KEEP_JUSTIFIED remains scoped to one finding and keeps the other finding reviewable', () => {
  const audit = buildCloneAudit(runWithFindings(familyDecisionFindings()), { decisions: [humanDecision('f1', 'KEEP_JUSTIFIED', 'Compatibility exception', 'alice')] });
  const family = audit.families[0];
  assert.equal(family.findingIds.length, 2);
  assert.equal(family.decisionCoverage.status, 'PARTIAL');
  assert.deepEqual(family.decisionCoverage.coveredFindingIds, ['f1']);
  assert.deepEqual(family.decisionCoverage.missingFindingIds, ['f2']);
  assert.equal(family.recommendation, 'REVIEW_FIRST');
  assert.equal(family.priority, 'REVIEW_REQUIRED');
  assert.equal(family.qualification.approvedDecision, null);
  assert.deepEqual(family.qualification.decisions, [{ findingId: 'f1', action: 'KEEP_JUSTIFIED', reason: 'Compatibility exception', reviewer: 'alice' }]);
  assert.equal(family.reviewPromptEligible, true);
  assert.equal(audit.prompts.length, 1);
  assert.match(audit.prompts[0].prompt, /f2/);
  assert.match(audit.prompts[0].prompt, /Existing decisions apply only to their stated findings/);
  assert.doesNotMatch(audit.prompts[0].prompt, /Proposed action: KEEP_JUSTIFIED/);
  const markdown = renderCloneMarkdown(audit);
  assert.match(markdown, /Decision coverage/);
  assert.match(markdown, /PARTIAL/);
  assert.match(JSON.stringify(audit), /Compatibility exception/);
});

test('partial FALSE_POSITIVE does not hide an unexamined family finding', () => {
  const audit = buildCloneAudit(runWithFindings(familyDecisionFindings()), { decisions: [humanDecision('f1', 'FALSE_POSITIVE', 'Only the first pair is generated code', 'bob')] });
  const family = audit.families[0];
  assert.equal(family.decisionCoverage.status, 'PARTIAL');
  assert.equal(family.recommendation, 'REVIEW_FIRST');
  assert.equal(family.priority, 'REVIEW_REQUIRED');
  assert.deepEqual(family.decisionCoverage.missingFindingIds, ['f2']);
  assert.equal(family.reviewPromptEligible, true);
});

test('contradictory family decisions are explicit and independent of input order', () => {
  const findings = familyDecisionFindings();
  const decisions = [
    humanDecision('f1', 'KEEP_JUSTIFIED', 'Pair one is required', 'alice'),
    humanDecision('f2', 'FALSE_POSITIVE', 'Pair two is noise', 'bob'),
  ];
  const first = buildCloneAudit(runWithFindings(findings), { decisions });
  const second = buildCloneAudit(runWithFindings(findings), { decisions: [...decisions].reverse() });
  const left = first.families[0];
  const right = second.families[0];
  assert.deepEqual(left.decisionCoverage, right.decisionCoverage);
  assert.equal(left.decisionCoverage.status, 'CONFLICT');
  assert.equal(left.recommendation, 'REVIEW_FIRST');
  assert.equal(left.priority, 'REVIEW_REQUIRED');
  assert.equal(left.qualification.approvedDecision, null);
  assert.deepEqual(left.qualification.decisions.map((decision) => decision.reviewer), ['alice', 'bob']);
  assert.equal(left.reviewPromptEligible, true);
});

test('compatible decisions cover every finding before a family can be justified', () => {
  const audit = buildCloneAudit(runWithFindings(familyDecisionFindings()), {
    decisions: [
      humanDecision('f2', 'KEEP_JUSTIFIED', 'Second pair is also required', 'bob'),
      humanDecision('f1', 'KEEP_JUSTIFIED', 'First pair is required', 'alice'),
    ],
  });
  const family = audit.families[0];
  assert.equal(family.decisionCoverage.status, 'COMPLETE');
  assert.deepEqual(family.decisionCoverage.coveredFindingIds, ['f1', 'f2']);
  assert.equal(family.recommendation, 'KEEP_JUSTIFIED');
  assert.equal(family.priority, 'P3');
  assert.equal(family.promptEligible, false);
  assert.equal(family.reviewPromptEligible, false);
  assert.deepEqual(family.qualification.decisions.map((decision) => decision.findingId), ['f1', 'f2']);
  assert.deepEqual(family.qualification.decisions.map((decision) => decision.reviewer), ['alice', 'bob']);
});

test('a decision outside a family has no effect on its decision coverage', () => {
  const findings = [...familyDecisionFindings(), fixtureFinding('f3', 'src/x.js', 1, 3, 'src/y.js', 10, 12, 'other-family')];
  const audit = buildCloneAudit(runWithFindings(findings), { decisions: [humanDecision('f3', 'KEEP_JUSTIFIED', 'Only the other family is accepted', 'carol')] });
  const family = audit.families.find((item) => item.findingIds.includes('f1'));
  assert.equal(family.decisionCoverage.status, 'NONE');
  assert.deepEqual(family.decisionCoverage.coveredFindingIds, []);
  assert.deepEqual(family.decisionCoverage.missingFindingIds, ['f1', 'f2']);
  assert.equal(family.recommendation, 'REVIEW_FIRST');
  assert.equal(family.priority, 'REVIEW_REQUIRED');
});

test('legacy runs and missing scanner measurements remain explicit insufficiency', () => {
  const audit = buildCloneAudit(runWithEngine([
    {
      id: 'legacy-jscpd',
      engine: 'jscpd',
      path: 'src/a.js'
    }
  ]));
  assert.equal(audit.status, 'INSUFFICIENT_DATA');
  assert.equal(audit.families.length, 0);
  assert.equal(
    audit.diagnostics.some((diagnostic) => diagnostic.code === 'CLONE_ENRICHMENT_UNAVAILABLE'),
    true
  );
  assert.match(renderCloneMarkdown(audit), /Données insuffisantes/);
});

test('clone triage is deterministic and does not write to the analyzed repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-clone-test-'));
  const finding = fixtureFinding('f1', 'src/a.js', 1, 3, 'src/b.js', 10, 12);
  const before = fs.readdirSync(root);
  const first = buildCloneAudit(runWithFindings([finding]));
  const second = buildCloneAudit(runWithFindings([finding]));
  assert.deepEqual(first, second);
  assert.deepEqual(fs.readdirSync(root), before);
});

test('clones CLI emits JSON and does not rerun a scanner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-clone-cli-'));
  const runPath = path.join(root, 'run.json');
  fs.writeFileSync(runPath, `${JSON.stringify(runWithFindings([fixtureFinding('f1', 'src/a.js', 1, 3, 'src/b.js', 10, 12)]))}\n`);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'quality-audit-kit.js'), 'clones', runPath, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.status, 'MEASURED');
  assert.equal(audit.counts.families, 1);
  assert.deepEqual(fs.readdirSync(root), ['run.json']);
});

test('clones CLI keeps imported failure status coherent in JSON and Markdown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-clone-status-cli-'));
  const run = runWithEngine([fixtureFinding('f-status', 'src/a.js', 1, 3, 'src/b.js', 10, 12)], 'FAILURE');
  const runPath = path.join(root, 'run.json');
  fs.writeFileSync(runPath, `${JSON.stringify(run)}\n`);
  const json = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'quality-audit-kit.js'), 'clones', runPath, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(json.status, 2, json.stderr);
  const audit = JSON.parse(json.stdout);
  assert.equal(audit.status, 'FAILURE');
  assert.equal(audit.evidenceContext.scanner.measurementStatus, 'FAILURE');
  assert.equal(audit.evidenceContext.cloneEvidence, 'FINDINGS_PRESENT_UNVERIFIED');
  const markdown = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'quality-audit-kit.js'), 'clones', runPath, '--format', 'markdown'], { encoding: 'utf8' });
  assert.equal(markdown.status, 2, markdown.stderr);
  assert.match(markdown.stdout, /Status: `FAILURE`/);
  assert.match(markdown.stdout, /jscpd measurement: `FAILURE`/);
  assert.match(markdown.stdout, /CLONE_ENGINE_STATUS_CONTRADICTION/);
  assert.deepEqual(fs.readdirSync(root), ['run.json']);
});

test('general reports do not trust a stale imported clone qualification', () => {
  const run = runWithEngine([fixtureFinding('f-report-status', 'src/a.js', 1, 3, 'src/b.js', 10, 12)], 'FAILURE');
  run.clones = { status: 'MEASURED', counts: { families: 1, occurrences: 2, pairs: 1 } };
  const structured = buildStructuredReport(run);
  assert.equal(structured.clones.status, 'FAILURE');
  assert.equal(structured.clones.evidenceContext.scanner.measurementStatus, 'FAILURE');
  assert.match(renderMarkdown(run), /Status: `FAILURE`/);
});

test('explicit clone annotation enables a protected review prompt export', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-clone-prompts-'));
  const run = runWithFindings([fixtureFinding('f1', 'src/a.js', 1, 3, 'src/b.js', 10, 12)]);
  const familyId = buildCloneAudit(run).families[0].id;
  run.cloneAnnotations = {
    [familyId]: {
      category: 'DUPLICATED_IMPLEMENTATION',
      source: 'HUMAN_REVIEW',
      evidence: 'A reviewer confirmed the implementation has a shared owner.',
    },
  };
  const runPath = path.join(root, 'run.json');
  const promptDirectory = path.join(root, 'prompts');
  fs.writeFileSync(runPath, `${JSON.stringify(run)}\n`);

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'quality-audit-kit.js'),
    'clones',
    runPath,
    '--format',
    'json',
    '--export',
    promptDirectory,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.prompts.length, 1);
  assert.equal(audit.families[0].recommendation, 'EXTRACT_SHARED_INFRASTRUCTURE');
  const promptPath = path.join(promptDirectory, audit.prompts[0].fileName);
  assert.match(fs.readFileSync(promptPath, 'utf8'), new RegExp(familyId));
  assert.deepEqual(fs.readdirSync(root).sort(), ['prompts', 'run.json']);
});
