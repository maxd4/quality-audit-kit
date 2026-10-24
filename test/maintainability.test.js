const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeRepository, importReport } = require('../src/maintainability');
const { compareRuns } = require('../src/history');
const { buildStructuredReport, renderMarkdown, renderTerminal, validateRun } = require('../src/report');

function fixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-maintainability-fixture-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.js\nignored-dir/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'simple.js'), 'export function simple(value) {\n  return value;\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'complex.mjs'), 'export function complex(value) {\n  if (value > 10) {\n    for (const item of value.items || []) {\n      if (item.active && item.score > 2) return item;\n    }\n  }\n  return null;\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'typed.ts'), 'export function typed(value: number): number {\n  return value + 1;\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'view.tsx'), 'export const View = (props: { title: string }) => <div>{props.title}</div>;\nconst values = [1, 2].map((item) => item + 1);\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'callbacks.js'), 'export const transform = (items) => items.map((item) => items.filter((value) => value > item));\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'valid-no-finding.js'), 'const answer = 42;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'invalid.js'), 'export function broken(value) {\n  if (value) {\n    return value;\n}\n', 'utf8');
  fs.writeFileSync(path.join(root, 'ignored.js'), 'export function ignored() { return 1; }\n', 'utf8');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-maintainability-outside-'));
  fs.writeFileSync(path.join(outside, 'outside.js'), 'export function outside() { return process.env.SECRET; }\n', 'utf8');
  let linkCreated = false;
  try {
    fs.symlinkSync(path.join(outside, 'outside.js'), path.join(root, 'src', 'external.js'), 'file');
    linkCreated = true;
  } catch {}
  return { root, outside, linkCreated };
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.outside, { recursive: true, force: true });
}

function verifiedRevision(seed = 'a') {
  return { status: 'VERIFIED', sha: seed.repeat(40).slice(0, 40), basis: 'fixture commit' };
}

test('maintainability measures JS, MJS, TS, TSX, arrows and nested callbacks with explicit coverage', () => {
  const fixture = fixtureRepository();
  try {
    const result = analyzeRepository(fixture.root);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.coverage.eligibleFiles.some((file) => file.path === 'src/invalid.js' && file.status === 'FAILURE'), true);
    assert.equal(result.coverage.measuredFiles.includes('src/simple.js'), true);
    assert.equal(result.coverage.measuredFiles.includes('src/complex.mjs'), true);
    assert.equal(result.coverage.measuredFiles.includes('src/typed.ts'), true);
    assert.equal(result.coverage.measuredFiles.includes('src/view.tsx'), true);
    assert.equal(result.coverage.measuredFiles.includes('ignored.js'), false);
    assert.equal(result.coverage.errorFiles.some((file) => file.path === 'src/invalid.js' && file.reason.includes('Unmatched')), true);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === 'PARSE_ERROR' && diagnostic.path === 'src/invalid.js'), true);
    assert.ok(result.coverage.functionsMeasured >= 8);
    assert.ok(result.measurements.every((measurement) => measurement.path !== 'ignored.js'));
    assert.ok(result.measurements.some((measurement) => measurement.path === 'src/simple.js' && measurement.metricId === 'cognitiveComplexity' && measurement.value === 0));
    assert.ok(result.measurements.some((measurement) => measurement.astRole === 'CALLBACK'));
    assert.ok(result.measurements.some((measurement) => measurement.astRole === 'ARROW_FUNCTION'));
    assert.ok(result.measurements.some((measurement) => measurement.path === 'src/complex.mjs' && measurement.metricId === 'cognitiveComplexity' && measurement.value > 0));
    assert.deepEqual(result.coverage.engines, [{ name: 'maintainability', version: '1.0.0', parser: 'qak-lexical-ast@1.0.0' }]);
    if (fixture.linkCreated) {
      assert.equal(result.coverage.excludedFiles.some((file) => file.path === 'src/external.js' && file.reason === 'SYMLINK_NOT_FOLLOWED'), true);
      assert.equal(result.measurements.some((measurement) => measurement.path === 'src/external.js'), false);
    }
  } finally {
    cleanup(fixture);
  }
});

test('missing optional adapter is explicit NOT_MEASURED and never fabricates zeroes', () => {
  const fixture = fixtureRepository();
  try {
    const result = analyzeRepository(fixture.root, { adapters: [] });
    assert.equal(result.status, 'NOT_MEASURED');
    assert.deepEqual(result.measurements, []);
    assert.match(result.coverage.reason, /No compatible local maintainability parser/);
    assert.equal(result.coverage.functionsMeasured, 0);
  } finally {
    cleanup(fixture);
  }
});

test('canonical function measurements validate, report offline and import without rerunning', () => {
  const fixture = fixtureRepository();
  try {
    const result = analyzeRepository(fixture.root, { sourceRevision: verifiedRevision() });
    const run = {
      schemaVersion: '0.1-draft',
      runId: 'maintainability-run-001',
      repository: { name: 'maintainability-fixture', contextCommitSha: verifiedRevision().sha },
      inputScope: 'COMMITTED_SNAPSHOT',
      reproducible: true,
      generatedAt: '2026-10-24T12:00:00.000Z',
      engines: [{ name: 'maintainability', version: '1.0.0', measurementStatus: result.status, gateOutcome: 'INFORMATIVE', gateRelevant: false, sourceRevision: verifiedRevision(), scope: 'function' }],
      findings: [],
      functionMeasurements: result.measurements,
      maintainabilityCoverage: result.coverage,
    };
    validateRun(run);
    const structured = buildStructuredReport(run);
    assert.deepEqual(structured.functionMeasurements, run.functionMeasurements);
    assert.match(renderMarkdown(run), /Function maintainability/);
    assert.match(renderMarkdown(run), /cognitiveComplexity/);
    assert.match(renderTerminal(run), /Functions measured/);
    const reportPath = path.join(fixture.root, 'maintainability-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ functionMeasurements: result.measurements, maintainabilityCoverage: result.coverage }), 'utf8');
    const imported = importReport(fixture.root, reportPath, verifiedRevision());
    assert.deepEqual(imported.measurements, result.measurements);
  } finally {
    cleanup(fixture);
  }
});

test('opt-in maintainability engine does not make an existing gate baseline incompatible', () => {
  const revision = verifiedRevision('b');
  const engine = { name: 'knip', measurementStatus: 'MEASURED', gateOutcome: 'INFORMATIVE', sourceRevision: revision };
  const finding = { id: 'knip:finding-1', engine: 'knip', ruleId: 'unused-export', path: 'src/a.js', severity: 'MEDIUM', message: 'unused export', measurementStatus: 'MEASURED', provenance: { kind: 'EXECUTION', reference: 'fixture', sourceRevision: revision } };
  const baseline = { schemaVersion: '0.1-draft', runId: 'baseline-run-001', repository: { name: 'history-fixture' }, inputScope: 'COMMITTED_SNAPSHOT', reproducible: true, engines: [engine], findings: [finding] };
  const current = { ...baseline, runId: 'current-run-001', engines: [engine, { name: 'maintainability', measurementStatus: 'MEASURED', gateOutcome: 'INFORMATIVE', gateRelevant: false, sourceRevision: revision }], functionMeasurements: [] };
  assert.equal(compareRuns(baseline, current).compatible, true);
});

test('CLI accepts --run=maintainability without installing or invoking another analyzer', () => {
  const fixture = fixtureRepository();
  try {
    const cli = path.resolve(__dirname, '..', 'bin', 'quality-audit-kit.js');
    const output = path.join(fixture.root, 'run.json');
    const result = spawnSync(process.execPath, [cli, 'scan', fixture.root, '--run=maintainability', '--output', output], { cwd: fixture.root, encoding: 'utf8', windowsHide: true });
    assert.ok([0, 2].includes(result.status), `${result.stderr}\n${result.stdout}`);
    const run = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(run.engines.some((engine) => engine.name === 'maintainability' && engine.gateRelevant === false), true);
    assert.equal(run.functionMeasurements.length > 0, true);
    assert.equal(run.engines.some((engine) => engine.name === 'knip' && engine.measurementStatus === 'NOT_MEASURED'), true);
  } finally {
    cleanup(fixture);
  }
});
