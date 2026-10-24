const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  COMMAND_EXPECTATIONS,
  compareSnapshots,
  evaluateTarget,
  pathKey,
  snapshotFiles,
  validatePlanArtifact,
  validateReportArtifact,
} = require('../tools/measure-workflows');

const ROOT = path.resolve(__dirname, '..');
const SARIF = path.join(ROOT, 'test', 'fixtures', 'sample.sarif');

function makeRepository(name) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `qak-harness-${name}-`));
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ name, private: true }, null, 2));
  fs.mkdirSync(path.join(repository, 'src'));
  fs.writeFileSync(path.join(repository, 'src', 'app.js'), 'export const app = true;\n');
  const init = spawnSync('git', ['init', '-q'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  for (const [key, value] of [['user.name', 'quality-audit-kit-test'], ['user.email', 'quality-audit-kit-test@example.invalid']]) {
    const config = spawnSync('git', ['config', key, value], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(config.status, 0, config.stderr);
  }
  const add = spawnSync('git', ['add', '--', '.'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr);
  return repository;
}

function removeRepository(repository) {
  fs.rmSync(repository, { recursive: true, force: true });
}

function writeSarif(repository, value) {
  const filePath = path.join(repository, 'input.sarif');
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  return filePath;
}

function gitStatus(repository) {
  return spawnSync('git', ['-C', repository, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout;
}

test('evaluation harness requires valid measured scan artifacts and records expected blocked steps', () => {
  const repository = makeRepository('positive');
  try {
    const result = evaluateTarget(repository, SARIF, 'positive');
    assert.equal(result.status, 'PASS_WITH_LIMITS', JSON.stringify(result.diagnostics));
    assert.equal(result.findings.stableIds, true);
    assert.equal(result.contentSnapshot.status, 'VERIFIED');
    assert.equal(result.contentPreserved, true);
    assert.equal(result.gitStatusPreserved, true);
    assert.equal(result.commands.find((command) => command.name === 'scan').outcome, 'PASS');
    assert.ok(['PASS', 'EXPECTED_BLOCKED'].includes(result.commands.find((command) => command.name === 'fix-preview').outcome));
    assert.deepEqual(COMMAND_EXPECTATIONS.scan.expectedExitCodes, [0]);
    assert.deepEqual(COMMAND_EXPECTATIONS.verify.expectedExitCodes, [0, 2]);
  } finally {
    removeRepository(repository);
  }
});

test('invalid and partial SARIF never become PASS_WITH_LIMITS', () => {
  const repository = makeRepository('negative');
  try {
    const invalid = writeSarif(repository, { version: '2.1.0', runs: 'not-an-array' });
    const invalidResult = evaluateTarget(repository, invalid, 'invalid');
    assert.notEqual(invalidResult.status, 'PASS_WITH_LIMITS');
    assert.ok(invalidResult.diagnostics.some((diagnostic) => diagnostic.stage === 'scan'));

    const partial = writeSarif(repository, { version: '2.1.0', runs: [{ tool: { driver: { name: 'partial-fixture' } } }] });
    const partialResult = evaluateTarget(repository, partial, 'partial');
    assert.notEqual(partialResult.status, 'PASS_WITH_LIMITS');
    assert.ok(partialResult.diagnostics.some((diagnostic) => diagnostic.code === 'SARIF_MEASUREMENT_NOT_MEASURED'));
  } finally {
    removeRepository(repository);
  }
});

test('artifact validators reject missing or unassigned report and plan outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-harness-artifacts-'));
  const run = { runId: 'run-12345678', repository: { name: 'fixture' } };
  try {
    const missingReport = validateReportArtifact(path.join(root, 'missing-report.json'), run);
    const missingPlan = validatePlanArtifact(path.join(root, 'missing-plan.json'), run);
    assert.equal(missingReport.ok, false);
    assert.equal(missingReport.diagnostic.code, 'ARTIFACT_MISSING');
    assert.equal(missingPlan.ok, false);
    assert.equal(missingPlan.diagnostic.code, 'ARTIFACT_MISSING');
    const reportPath = path.join(root, 'wrong-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ reportType: 'QUALITY_AUDIT_RUN_REPORT', runId: 'other-run', measurements: [], findings: {} }));
    const wrongReport = validateReportArtifact(reportPath, run);
    assert.equal(wrongReport.ok, false);
    assert.ok(wrongReport.diagnostics.some((diagnostic) => diagnostic.code === 'REPORT_RUN_ID_MISMATCH'));
  } finally {
    removeRepository(root);
  }
});

test('content snapshots detect changes hidden by an unchanged Git status', () => {
  const repository = makeRepository('mutation');
  try {
    const tracked = path.join(repository, 'src', 'app.js');
    fs.writeFileSync(tracked, 'pre-existing dirty content\n');
    const beforeTracked = snapshotFiles(repository);
    const statusBefore = gitStatus(repository);
    fs.writeFileSync(tracked, 'changed again without changing the path\n');
    const afterTracked = snapshotFiles(repository);
    assert.equal(statusBefore, gitStatus(repository));
    assert.equal(compareSnapshots(beforeTracked, afterTracked).status, 'MUTATED');

    const untracked = path.join(repository, 'observed.txt');
    fs.writeFileSync(untracked, 'first\n');
    const beforeUntracked = snapshotFiles(repository);
    const untrackedStatusBefore = gitStatus(repository);
    fs.writeFileSync(untracked, 'second\n');
    const afterUntracked = snapshotFiles(repository);
    assert.equal(untrackedStatusBefore, gitStatus(repository));
    assert.equal(compareSnapshots(beforeUntracked, afterUntracked).status, 'MUTATED');
  } finally {
    removeRepository(repository);
  }
});

test('target aliases are treated as one repository, not two independent measurements', () => {
  const repository = makeRepository('identity');
  try {
    const alias = path.join(repository, '..', path.basename(repository));
    assert.equal(pathKey(repository), pathKey(alias));
    assert.equal(pathKey(repository), pathKey(fs.realpathSync(repository)));
    const harness = spawnSync(process.execPath, [
      path.join(ROOT, 'tools', 'measure-workflows.js'),
      '--target',
      repository,
      '--target',
      alias,
      '--sarif',
      SARIF,
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(harness.status, 2, harness.stderr);
    const payload = JSON.parse(harness.stdout);
    assert.equal(payload.status, 'FAILURE');
    assert.equal(payload.results[1].diagnostics[0].code, 'DUPLICATE_TARGET');
  } finally {
    removeRepository(repository);
  }
});

test('snapshot file records include deterministic size and SHA-256 evidence', () => {
  const repository = makeRepository('hashes');
  try {
    const snapshot = snapshotFiles(repository);
    const record = snapshot.files['src/app.js'];
    assert.equal(snapshot.status, 'VERIFIED');
    assert.equal(record.size, Buffer.byteLength('export const app = true;\n'));
    assert.equal(record.sha256, crypto.createHash('sha256').update('export const app = true;\n').digest('hex'));
    assert.equal(snapshot.ignoredFilesNotObserved, true);
  } finally {
    removeRepository(repository);
  }
});
