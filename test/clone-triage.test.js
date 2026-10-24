const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { buildCloneAudit, renderCloneMarkdown } = require('../src/clone-triage');
const { assessMeasuredRun } = require('../src/history');
const { normalizeJscpd } = require('../src/normalize');

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
  const audit = buildCloneAudit(runWithFindings([]));
  assert.equal(audit.status, 'INSUFFICIENT_DATA');
  assert.equal(audit.families.length, 0);
  assert.equal(audit.diagnostics[0].code, 'CLONE_DATA_UNAVAILABLE');
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
