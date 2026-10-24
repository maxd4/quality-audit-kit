const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createDeterministicAdapter } = require('../src/agents');
const { classifyExecution, executeFix, verifyFixResult } = require('../src/fix');
const { buildPlan, nextLot } = require('../src/planner');
const { buildSarif, importSarifFile } = require('../src/sarif');
const { connectSonar, importSonar } = require('../src/sonar');
const { buildStructuredReport, createBundle, createZip, readZipEntries, validateRun, verifyBundle } = require('../src/report');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'quality-audit-kit.js');

function makeRepository(name = 'independent-fixture') {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-test-'));
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({
    name,
    private: true,
    workspaces: ['packages/*'],
    scripts: { knip: 'knip', duplicate: 'jscpd .' },
  }, null, 2));
  fs.writeFileSync(path.join(repository, 'package-lock.json'), '{}\n');
  fs.mkdirSync(path.join(repository, 'packages', 'app'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'packages', 'app', 'package.json'), '{"name":"app"}\n');
  fs.writeFileSync(path.join(repository, 'knip.json'), '{}\n');
  fs.writeFileSync(path.join(repository, '.jscpd.json'), '{}\n');
  return repository;
}

function makeEmptyRepository() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-empty-'));
}

function runCli(repository, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function cleanup(repository) {
  fs.rmSync(repository, { recursive: true, force: true });
}

function initializeGit(repository) {
  const init = spawnSync('git', ['init', '-q'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  for (const [key, value] of [['user.name', 'quality-audit-kit-test'], ['user.email', 'quality-audit-kit-test@example.invalid']]) {
    const config = spawnSync('git', ['config', key, value], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(config.status, 0, config.stderr);
  }
  const add = spawnSync('git', ['add', '-f', '--', '.'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(commit.status, 0, commit.stderr);
}

function measuredRevision(seed, status = 'VERIFIED') {
  return {
    status,
    sha: status === 'VERIFIED' ? String(seed).repeat(40).slice(0, 40) : null,
    basis: status === 'VERIFIED' ? 'independent test fixture commit' : 'fixture does not prove a source revision',
  };
}

function measuredRun({ runId, repository = 'history-fixture', seed, findings = [], measurementStatus = 'MEASURED', sourceStatus = 'VERIFIED' }) {
  const sourceRevision = measuredRevision(seed, sourceStatus);
  return {
    schemaVersion: '0.1-draft',
    runId,
    repository: { name: repository },
    inputScope: 'COMMITTED_SNAPSHOT',
    reproducible: sourceStatus === 'VERIFIED',
    generatedAt: '2026-10-24T12:00:00.000Z',
    engines: [{
      name: 'knip',
      measurementStatus,
      gateOutcome: measurementStatus === 'MEASURED' ? 'INFORMATIVE' : 'NOT_EVALUATED',
      sourceRevision,
      scope: '.',
    }],
    findings: findings.map((finding) => ({
      id: finding.id,
      engine: 'knip',
      ruleId: finding.ruleId || 'unused-export',
      path: finding.path,
      line: finding.line || 1,
      severity: finding.severity || 'MEDIUM',
      message: finding.message,
      lifecycle: 'UNCLASSIFIED',
      measurementStatus: 'MEASURED',
      provenance: {
        kind: 'EXECUTION',
        reference: 'independent-fixture-scanner',
        sourceRevision,
      },
    })),
  };
}

test('init creates an explicit config and reports detected structure', () => {
  const repository = makeRepository();
  try {
    const result = runCli(repository, ['init']);
    assert.equal(result.status, 0);
    const config = JSON.parse(fs.readFileSync(path.join(repository, 'quality-audit-kit.config.json'), 'utf8'));
    assert.equal(config.version, '0.1-draft');
    assert.deepEqual(config.quality.ratchet.blockingSeverities, ['HIGH', 'CRITICAL']);
    assert.equal(config.quality.ratchet.maxNewBlockingFindings, 0);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.workspaces.packages, ['packages/app']);
    assert.deepEqual(summary.scanners.map((scanner) => scanner.name), ['knip', 'jscpd']);
    assert.equal(summary.templates.files.map((file) => file.file).includes('PROJECT_HANDOFF.md'), true);
    assert.equal(summary.templates.files.map((file) => file.file).includes('COMMIT_REVIEW.md'), true);
    const handoff = fs.readFileSync(path.join(repository, 'PROJECT_HANDOFF.md'), 'utf8');
    const review = fs.readFileSync(path.join(repository, 'COMMIT_REVIEW.md'), 'utf8');
    assert.match(handoff, /UNKNOWN/);
    assert.match(handoff, /packages\/app/);
    assert.match(review, /Generic review protocol/);
    assert.doesNotMatch(`${handoff}\n${review}`, /CleanMyMap|Clerk|Supabase/);
  } finally {
    cleanup(repository);
  }
});

test('init works on an empty repository without inventing project facts', () => {
  const repository = makeEmptyRepository();
  try {
    const result = runCli(repository, ['init']);
    assert.equal(result.status, 0, result.stderr);
    const handoff = fs.readFileSync(path.join(repository, 'PROJECT_HANDOFF.md'), 'utf8');
    assert.match(handoff, /Package manager: UNKNOWN/);
    assert.match(handoff, /Purpose and users: UNKNOWN/);
    assert.equal(fs.existsSync(path.join(repository, 'AGENTS.md')), false);
  } finally {
    cleanup(repository);
  }
});

test('template refresh previews and preserves manual decisions idempotently', () => {
  const repository = makeRepository('template-refresh-fixture');
  try {
    assert.equal(runCli(repository, ['init']).status, 0);
    const handoffPath = path.join(repository, 'PROJECT_HANDOFF.md');
    const original = fs.readFileSync(handoffPath, 'utf8');
    const edited = original.replace('- Decision: UNKNOWN', '- Decision: keep the explicit local workflow\n- Decision owner: user');
    fs.writeFileSync(handoffPath, edited, 'utf8');

    const preview = runCli(repository, ['init', '--update-templates', '--preview']);
    assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
    const previewSummary = JSON.parse(preview.stdout);
    assert.equal(previewSummary.configStatus, 'PREVIEW');
    assert.equal(previewSummary.templates.files.some((file) => file.status === 'PREVIEW'), true);
    assert.match(previewSummary.templates.diffs.join('\n'), /Decision: keep the explicit local workflow/);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), edited);

    const updated = runCli(repository, ['init', '--update-templates']);
    assert.equal(updated.status, 0, updated.stderr);
    const refreshed = fs.readFileSync(handoffPath, 'utf8');
    assert.match(refreshed, /Decision: keep the explicit local workflow/);
    assert.equal((refreshed.match(/QAK:BEGIN GENERATED/g) || []).length, 1);
    assert.equal((refreshed.match(/QAK:BEGIN MANUAL/g) || []).length, 1);
    assert.equal((refreshed.match(/Decision: keep the explicit local workflow/g) || []).length, 1);
    const second = runCli(repository, ['init', '--update-templates']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), refreshed);
  } finally {
    cleanup(repository);
  }
});

test('Codex customization is explicit and never executed implicitly', () => {
  const repository = makeRepository('agent-fixture');
  try {
    const prepared = runCli(repository, ['init', '--agent', 'codex', '--agent-prompt', '.qak-codex-request.md']);
    assert.equal(prepared.status, 0, prepared.stderr);
    const preparedSummary = JSON.parse(prepared.stdout);
    assert.equal(preparedSummary.templates.agent.status, 'NOT_EXECUTED');
    const prompt = fs.readFileSync(path.join(repository, '.qak-codex-request.md'), 'utf8');
    assert.match(prompt, /Inspect the real repository/);
    assert.match(prompt, /knip.json/);

    fs.writeFileSync(path.join(repository, 'agent-proposal.json'), JSON.stringify({
      projectHandoffGenerated: '## Agent-confirmed observation\n\n- FACT: proposal was based on an explicit repository inspection.',
      commitReviewGenerated: '## Agent-confirmed control\n\n- FACT: review proposal is supplied explicitly by the user.',
    }));
    const applied = runCli(repository, ['init', '--agent', 'codex', '--agent-input', 'agent-proposal.json', '--update-templates']);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedSummary = JSON.parse(applied.stdout);
    assert.equal(appliedSummary.templates.agent.status, 'APPLIED_FROM_EXPLICIT_INPUT');
    assert.match(fs.readFileSync(path.join(repository, 'PROJECT_HANDOFF.md'), 'utf8'), /Agent-confirmed observation/);
    assert.match(fs.readFileSync(path.join(repository, 'COMMIT_REVIEW.md'), 'utf8'), /Agent-confirmed control/);
  } finally {
    cleanup(repository);
  }
});

test('AGENTS link is opt-in, bounded and idempotent', () => {
  const repository = makeRepository('agents-link-fixture');
  try {
    const agentsPath = path.join(repository, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Existing governance\n\nKeep this text.\n', 'utf8');
    assert.equal(runCli(repository, ['init']).status, 0);
    assert.doesNotMatch(fs.readFileSync(agentsPath, 'utf8'), /QAK:BEGIN AGENTS_LINK/);
    assert.equal(runCli(repository, ['init', '--link-agents']).status, 0);
    const linked = fs.readFileSync(agentsPath, 'utf8');
    assert.match(linked, /Keep this text/);
    assert.equal((linked.match(/QAK:BEGIN AGENTS_LINK/g) || []).length, 1);
    assert.equal(runCli(repository, ['init', '--link-agents']).status, 0);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), linked);
  } finally {
    cleanup(repository);
  }
});

test('template refresh refuses unmanaged documents without mutation', () => {
  const repository = makeRepository('unmanaged-template-fixture');
  try {
    const handoffPath = path.join(repository, 'PROJECT_HANDOFF.md');
    const content = '# User-owned handoff\n\nDo not replace this document.\n';
    fs.writeFileSync(handoffPath, content, 'utf8');
    const result = runCli(repository, ['init', '--update-templates']);
    assert.equal(result.status, 2);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.templates.files.find((file) => file.file === 'PROJECT_HANDOFF.md').status, 'BLOCKED');
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), content);
  } finally {
    cleanup(repository);
  }
});

test('context refresh updates facts only and signals contradictions', () => {
  const repository = makeRepository('context-refresh-fixture');
  try {
    assert.equal(runCli(repository, ['init']).status, 0);
    const handoffPath = path.join(repository, 'PROJECT_HANDOFF.md');
    const reviewPath = path.join(repository, 'COMMIT_REVIEW.md');
    const initialHandoff = fs.readFileSync(handoffPath, 'utf8');
    const initialReview = fs.readFileSync(reviewPath, 'utf8');
    fs.writeFileSync(handoffPath, initialHandoff.replace('- Decision: UNKNOWN', '- Package manager: npm\n- Decision: keep the human decision'), 'utf8');
    fs.writeFileSync(path.join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    fs.mkdirSync(path.join(repository, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repository, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
    const packageJsonPath = path.join(repository, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    packageJson.scripts.build = 'node build.js';
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

    const preview = runCli(repository, ['context', 'refresh', '--preview']);
    assert.equal(preview.status, 2, preview.stderr);
    const previewSummary = JSON.parse(preview.stdout);
    assert.equal(previewSummary.status, 'CONTRADICTIONS');
    assert.equal(previewSummary.preview, true);
    assert.equal(previewSummary.changedFacts.some((fact) => fact.field === 'package manager'), true);
    assert.equal(previewSummary.contradictions.some((fact) => fact.field === 'package manager'), true);
    assert.equal(fs.readFileSync(handoffPath, 'utf8'), initialHandoff.replace('- Decision: UNKNOWN', '- Package manager: npm\n- Decision: keep the human decision'));

    const refreshed = runCli(repository, ['context', 'refresh']);
    assert.equal(refreshed.status, 2, refreshed.stderr);
    const refreshedSummary = JSON.parse(refreshed.stdout);
    assert.equal(refreshedSummary.status, 'CONTRADICTIONS');
    const refreshedHandoff = fs.readFileSync(handoffPath, 'utf8');
    const refreshedReview = fs.readFileSync(reviewPath, 'utf8');
    assert.match(refreshedHandoff, /Package manager: pnpm/);
    assert.match(refreshedHandoff, /Package manager: npm/);
    assert.match(refreshedHandoff, /Decision: keep the human decision/);
    assert.equal(refreshedReview.includes('build'), true);
    assert.equal(refreshedReview.includes('.github/workflows/ci.yml'), true);
    assert.equal(refreshedReview.includes('Generic review protocol'), true);
    assert.equal((refreshedHandoff.match(/QAK:BEGIN DETECTED_FACTS/g) || []).length, 1);
    assert.equal((refreshedReview.match(/QAK:BEGIN DETECTED_CONTROLS/g) || []).length, 1);
    assert.equal(initialReview.includes('Generic review protocol'), true);
  } finally {
    cleanup(repository);
  }
});

test('scan imports Knip and jscpd reports into one stable contract', () => {
  const repository = makeRepository();
  try {
    initializeGit(repository);
    fs.writeFileSync(path.join(repository, 'knip-report.json'), JSON.stringify({
      issues: [{ file: 'packages/app/src.js', exports: [{ name: 'unused', line: 4 }] }],
      files: ['packages/app/old.js'],
    }));
    fs.writeFileSync(path.join(repository, 'jscpd-report.json'), JSON.stringify({
      duplicates: [{
        lines: 24,
        format: { percentage: 12 },
        firstFile: { name: 'packages/app/a.js', start: 3, end: 26 },
        secondFile: { name: 'packages/app/b.js', start: 8, end: 31 },
      }],
    }));
    const first = runCli(repository, ['scan', '--output', 'run-one.json']);
    const second = runCli(repository, ['scan', '--output', 'run-two.json']);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    const runOne = JSON.parse(fs.readFileSync(path.join(repository, 'run-one.json'), 'utf8'));
    const runTwo = JSON.parse(fs.readFileSync(path.join(repository, 'run-two.json'), 'utf8'));
    assert.equal(runOne.inputScope, 'WORKTREE_LIVE');
    assert.equal(runOne.engines.every((engine) => engine.measurementStatus === 'MEASURED'), true);
    assert.equal(runOne.findings.length, 3);
    assert.equal(runOne.findings.every((finding) => finding.measurementStatus === 'MEASURED'), true);
    assert.equal(runOne.findings.every((finding) => finding.lifecycle === 'UNCLASSIFIED'), true);
    assert.equal(runOne.findings.every((finding) => finding.provenance.kind === 'REPORT'), true);
    assert.equal(runOne.findings.every((finding) => finding.provenance.sourceRevision.status === 'UNKNOWN'), true);
    assert.equal(runOne.engines.find((engine) => engine.name === 'knip').sourceRevision.status, 'UNKNOWN');
    assert.match(runOne.repository.contextCommitSha, /^[a-f0-9]{40}$/);
    assert.equal(runOne.repository.commitSha, runOne.repository.contextCommitSha);
    assert.equal(runOne.reproducible, false);
    assert.deepEqual(runOne.discovery.workspaces.packages, ['packages/app']);
    assert.deepEqual(runOne.findings.map((finding) => finding.id), runTwo.findings.map((finding) => finding.id));
    assert.equal(runOne.findings.some((finding) => path.isAbsolute(finding.path)), false);

    const report = runCli(repository, ['report', 'run-one.json']);
    assert.equal(report.status, 0);
    assert.match(report.stdout, /Measurement status/);
    assert.match(report.stdout, /duplicate-code/);
    assert.match(report.stdout, /UNCLASSIFIED/);
    assert.match(report.stdout, /Source revision/);
  } finally {
    cleanup(repository);
  }
});

test('scan preserves missing and failed measurement states', () => {
  const repository = makeRepository('negative-fixture');
  try {
    const missing = runCli(repository, ['scan', '--run', '--output', 'missing.json']);
    assert.equal(missing.status, 0);
    const missingRun = JSON.parse(fs.readFileSync(path.join(repository, 'missing.json'), 'utf8'));
    assert.equal(missingRun.findings.length, 0);
    assert.equal(missingRun.engines.every((engine) => engine.measurementStatus === 'NOT_MEASURED'), true);
    assert.equal(missingRun.engines.every((engine) => engine.gateOutcome === 'NOT_EVALUATED'), true);

    fs.writeFileSync(path.join(repository, 'bad.json'), '{not-json');
    const failed = runCli(repository, ['scan', '--knip-report', 'bad.json', '--output', 'failed.json']);
    assert.equal(failed.status, 2);
    const failedRun = JSON.parse(fs.readFileSync(path.join(repository, 'failed.json'), 'utf8'));
    assert.equal(failedRun.engines.find((engine) => engine.name === 'knip').measurementStatus, 'FAILURE');
    assert.equal(failedRun.engines.find((engine) => engine.name === 'jscpd').measurementStatus, 'NOT_MEASURED');
  } finally {
    cleanup(repository);
  }
});

test('report produces deterministic views, an offline bundle and refuses overwrites', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({ runId: 'report-run-0001', seed: 'a', findings: [{ id: 'finding-report-0001', path: 'src/unused.js', message: 'unused export' }] });
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    fs.writeFileSync(path.join(repository, 'evidence.md'), '# Authorized evidence\n\nNo source or secret.\n');

    const terminal = runCli(repository, ['report', 'run.json']);
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.match(terminal.stdout, /No global quality score/);
    assert.match(terminal.stdout, /Unclassified: 1/);

    const jsonOne = runCli(repository, ['report', 'run.json', '--format', 'json', '--output', 'report-one.json']);
    const jsonTwo = runCli(repository, ['report', 'run.json', '--format', 'json', '--output', 'report-two.json']);
    assert.equal(jsonOne.status, 0, jsonOne.stderr);
    assert.equal(jsonTwo.status, 0, jsonTwo.stderr);
    const structured = JSON.parse(fs.readFileSync(path.join(repository, 'report-one.json'), 'utf8'));
    assert.equal(structured.runId, run.runId);
    assert.equal(structured.measurements[0].runId, run.runId);
    assert.equal(structured.measurements[0].sha, run.engines[0].sourceRevision.sha);
    assert.equal(structured.measurements[0].validationState, 'VALIDATED');
    assert.equal(Object.hasOwn(structured, 'score'), false);
    assert.deepEqual(fs.readFileSync(path.join(repository, 'report-one.json')), fs.readFileSync(path.join(repository, 'report-two.json')));

    const markdown = runCli(repository, ['report', 'run.json', '--format', 'markdown', '--output', 'report.md']);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(fs.readFileSync(path.join(repository, 'report.md'), 'utf8'), /## Measurement failures/);

    const bundleOne = runCli(repository, ['report', 'run.json', '--format', 'zip', '--output', 'bundle-one.zip', '--include-evidence', 'evidence.md']);
    const bundleTwo = runCli(repository, ['report', 'run.json', '--format', 'zip', '--output', 'bundle-two.zip', '--include-evidence', 'evidence.md']);
    assert.equal(bundleOne.status, 0, bundleOne.stderr);
    assert.equal(bundleTwo.status, 0, bundleTwo.stderr);
    assert.deepEqual(fs.readFileSync(path.join(repository, 'bundle-one.zip')), fs.readFileSync(path.join(repository, 'bundle-two.zip')));
    const verified = runCli(repository, ['report', '--verify-bundle', 'bundle-one.zip']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /"verified": true/);
    assert.match(verified.stdout, /"runId": "report-run-0001"/);

    const overwrite = runCli(repository, ['report', 'run.json', '--format', 'json', '--output', 'report-one.json']);
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /Refusing to overwrite existing artifact/);

    fs.writeFileSync(path.join(repository, 'locked.json.qak-lock'), 'another run is writing');
    const locked = runCli(repository, ['report', 'run.json', '--format', 'json', '--output', 'locked.json']);
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /Refusing concurrent write/);
    fs.rmSync(path.join(repository, 'locked.json.qak-lock'), { force: true });

    const corrupt = Buffer.from(fs.readFileSync(path.join(repository, 'bundle-one.zip')));
    corrupt[corrupt.length - 25] ^= 0xff;
    fs.writeFileSync(path.join(repository, 'bundle-corrupt.zip'), corrupt);
    const invalidBundle = runCli(repository, ['report', '--verify-bundle', 'bundle-corrupt.zip']);
    assert.notEqual(invalidBundle.status, 0);
    assert.match(invalidBundle.stderr, /ZIP|checksum|Bundle/);
  } finally {
    cleanup(repository);
  }
});

test('report rejects SHA/run identity contradictions and unsafe evidence', () => {
  const repository = makeEmptyRepository();
  try {
    const inconsistent = measuredRun({ runId: 'report-run-0002', seed: 'b' });
    inconsistent.repository.commitSha = 'c'.repeat(40);
    inconsistent.repository.contextCommitSha = 'd'.repeat(40);
    fs.writeFileSync(path.join(repository, 'inconsistent.json'), `${JSON.stringify(inconsistent, null, 2)}\n`);
    const invalidRun = runCli(repository, ['report', 'inconsistent.json', '--format', 'json', '--output', 'should-not-exist.json']);
    assert.notEqual(invalidRun.status, 0);
    assert.match(invalidRun.stderr, /inconsistent.*commitSha/i);
    assert.equal(fs.existsSync(path.join(repository, 'should-not-exist.json')), false);

    const valid = measuredRun({ runId: 'report-run-0003', seed: 'e' });
    fs.writeFileSync(path.join(repository, 'valid.json'), `${JSON.stringify(valid, null, 2)}\n`);
    fs.writeFileSync(path.join(repository, 'secret.txt'), 'token=ghp_1234567890abcdef\n');
    fs.writeFileSync(path.join(repository, 'source.js'), 'const source = true;\n');
    const secretBundle = runCli(repository, ['report', 'valid.json', '--format', 'zip', '--output', 'secret.zip', '--include-evidence', 'secret.txt']);
    assert.notEqual(secretBundle.status, 0);
    assert.match(secretBundle.stderr, /approved|sensitive/i);
    assert.equal(fs.existsSync(path.join(repository, 'secret.zip')), false);
    const sourceBundle = runCli(repository, ['report', 'valid.json', '--format', 'zip', '--output', 'source.zip', '--include-evidence', 'source.js']);
    assert.notEqual(sourceBundle.status, 0);
    assert.equal(fs.existsSync(path.join(repository, 'source.zip')), false);
  } finally {
    cleanup(repository);
  }
});

test('offline bundles refuse symlink escapes and redact Unix absolute paths', () => {
  const repository = makeEmptyRepository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-outside-'));
  try {
    const run = measuredRun({ runId: 'report-run-0004', seed: 'f', findings: [{ id: 'finding-report-0004', path: 'src/private.js', message: 'private path diagnostic' }] });
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    fs.writeFileSync(path.join(outside, 'outside.md'), '# outside evidence\n', 'utf8');
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(repository, 'evidence-link.md'), 'file');
    const escaped = runCli(repository, ['report', 'run.json', '--format', 'zip', '--output', 'escaped.zip', '--include-evidence', 'evidence-link.md']);
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /outside|destination|safely|Evidence/i);
    assert.equal(fs.existsSync(path.join(repository, 'escaped.zip')), false);

    run.repository.name = '/home/user/private/project';
    run.repository.sourceScopeDescription = '/home/user/private/file';
    run.engines[0].diagnostic = 'read /home/user/private/scanner.log';
    run.findings[0] = { ...run.findings[0], message: 'found /home/user/private/secret.txt' };
    const bundlePath = path.join(repository, 'redacted.zip');
    createBundle(run, path.join(repository, 'run.json'), bundlePath);
    const bundleBytes = fs.readFileSync(bundlePath).toString('utf8');
    assert.equal(bundleBytes.includes('/home/user/private'), false);
    const bundleEntries = readZipEntries(bundlePath);
    for (const data of bundleEntries.values()) assert.equal(data.toString('utf8').includes('/home/user/private'), false);
  } finally {
    cleanup(repository);
    cleanup(outside);
  }
});

test('offline verification rejects forged metadata and unlisted ZIP entries with valid CRCs', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({ runId: 'report-run-0005', seed: '1' });
    const validPath = path.join(repository, 'valid.zip');
    createBundle(run, path.join(repository, 'run.json'), validPath);
    assert.equal(verifyBundle(validPath).verified, true);
    const original = readZipEntries(validPath);

    const forgedManifest = JSON.parse(original.get('manifest.json').toString('utf8'));
    const forgedInventory = JSON.parse(original.get('inventory.json').toString('utf8'));
    forgedManifest.contentFiles[0].sha256 = 'a'.repeat(64);
    forgedInventory.entries[0].sha256 = 'a'.repeat(64);
    const forgedEntries = [...original.entries()].map(([name, data]) => {
      if (name === 'manifest.json') return { name, data: Buffer.from(`${JSON.stringify(forgedManifest, null, 2)}\n`) };
      if (name === 'inventory.json') return { name, data: Buffer.from(`${JSON.stringify(forgedInventory, null, 2)}\n`) };
      return { name, data };
    });
    const forgedPath = path.join(repository, 'forged-metadata.zip');
    fs.writeFileSync(forgedPath, createZip(forgedEntries));
    assert.throws(() => verifyBundle(forgedPath), /metadata|actual entry|checksum|integrity/i);

    const extraPath = path.join(repository, 'unlisted-entry.zip');
    fs.writeFileSync(extraPath, createZip([...original.entries()].map(([name, data]) => ({ name, data })).concat({ name: 'extra.md', data: Buffer.from('not inventoried\n') })));
    assert.throws(() => verifyBundle(extraPath), /inventoried|entry|extra/i);
  } finally {
    cleanup(repository);
  }
});

test('scan executes only locally installed scanners when explicitly requested', () => {
  const repository = makeRepository('execution-fixture');
  try {
    const binDirectory = path.join(repository, 'node_modules', '.bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    const commands = {
      knip: '{"issues":[{"file":"src.js","exports":[{"name":"unused","line":1}]}]}',
      jscpd: '{"duplicates":[]}',
    };
    for (const [name, output] of Object.entries(commands)) {
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDirectory, `${name}.cmd`), `@echo ${output}\r\n`);
      } else {
        const file = path.join(binDirectory, name);
        fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
        fs.chmodSync(file, 0o755);
      }
    }
    initializeGit(repository);
    const result = runCli(repository, ['scan', '--run=knip,jscpd', '--output', 'executed.json']);
    const output = fs.readFileSync(path.join(repository, 'executed.json'), 'utf8');
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${output}`);
    const run = JSON.parse(output);
    assert.equal(run.engines.every((engine) => engine.measurementStatus === 'MEASURED'), true);
    assert.equal(run.engines.every((engine) => engine.sourceRevision.status === 'VERIFIED'), true, JSON.stringify(run.engines));
    assert.equal(run.findings.length, 1);
    assert.equal(run.findings[0].provenance.kind, 'EXECUTION');
    assert.equal(run.findings[0].provenance.sourceRevision.status, 'VERIFIED');
  } finally {
    cleanup(repository);
  }
});

test('scanner execution distinguishes expected findings exit from execution failure', () => {
  const repository = makeRepository('exit-code-fixture');
  try {
    const binDirectory = path.join(repository, 'node_modules', '.bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    const writeScanner = (name, json, exitCode) => {
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDirectory, `${name}.cmd`), `@echo ${json}\r\n@exit /b ${exitCode}\r\n`);
      } else {
        const file = path.join(binDirectory, name);
        fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${json}'\nexit ${exitCode}\n`);
        fs.chmodSync(file, 0o755);
      }
    };
    writeScanner('knip', '{"issues":[{"file":"src.js","exports":[{"name":"unused","line":1}]}]}', 2);
    writeScanner('jscpd', '{"duplicates":[]}', 0);
    const failed = runCli(repository, ['scan', '--run=knip,jscpd', '--output', 'unexpected.json']);
    assert.equal(failed.status, 2);
    const failedRun = JSON.parse(fs.readFileSync(path.join(repository, 'unexpected.json'), 'utf8'));
    const failedKnip = failedRun.engines.find((engine) => engine.name === 'knip');
    assert.equal(failedKnip.measurementStatus, 'FAILURE');
    assert.match(failedKnip.diagnostic, /not accepted as a complete measurement/);
    assert.equal(failedRun.findings.length, 0);
    assert.equal(failedRun.engines.find((engine) => engine.name === 'jscpd').measurementStatus, 'MEASURED');

    writeScanner('knip', '{"issues":[{"file":"src.js","exports":[{"name":"unused","line":1}]}]}', 1);
    const expected = runCli(repository, ['scan', '--run=knip,jscpd', '--output', 'expected.json']);
    assert.equal(expected.status, 0, expected.stderr);
    const expectedRun = JSON.parse(fs.readFileSync(path.join(repository, 'expected.json'), 'utf8'));
    const expectedKnip = expectedRun.engines.find((engine) => engine.name === 'knip');
    assert.equal(expectedKnip.measurementStatus, 'MEASURED');
    assert.match(expectedKnip.diagnostic, /expected findings code 1/);
    assert.equal(expectedRun.findings.length, 1);
  } finally {
    cleanup(repository);
  }
});

test('baseline comparison preserves line moves and correlates a unique file move', () => {
  const repository = makeEmptyRepository();
  try {
    const baselineRun = measuredRun({
      runId: 'run-history-one',
      seed: 'a',
      findings: [
        { id: 'knip:line-stable-finding', path: 'src/a.js', line: 4, message: 'unused export: helper' },
        { id: 'knip:file-old-finding', path: 'src/old.js', line: 8, message: 'unused export: movedSymbol' },
      ],
    });
    const currentRun = measuredRun({
      runId: 'run-history-two',
      seed: 'b',
      findings: [
        { id: 'knip:line-stable-finding', path: 'src/a.js', line: 44, message: 'unused export: helper' },
        { id: 'knip:file-new-finding', path: 'src/new.js', line: 2, message: 'unused export: movedSymbol' },
      ],
    });
    fs.writeFileSync(path.join(repository, 'baseline-source.json'), JSON.stringify(baselineRun, null, 2));
    fs.writeFileSync(path.join(repository, 'current.json'), JSON.stringify(currentRun, null, 2));
    assert.equal(runCli(repository, ['baseline', 'baseline-source.json', '--output', 'baseline.json']).status, 0);
    const result = runCli(repository, ['triage', 'current.json', '--baseline', 'baseline.json']);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'PASS');
    assert.equal(summary.findings.find((finding) => finding.id === 'knip:line-stable-finding').lifecycle, 'HISTORICAL_ACTIONABLE');
    assert.equal(summary.findings.find((finding) => finding.id === 'knip:file-new-finding').lifecycle, 'HISTORICAL_ACTIONABLE');
    assert.equal(summary.comparison.matches.find((match) => match.currentFindingId === 'knip:line-stable-finding').matchedBy, 'ID');
    assert.equal(summary.comparison.matches.find((match) => match.currentFindingId === 'knip:file-new-finding').matchedBy, 'COMPARISON_KEY');
  } finally {
    cleanup(repository);
  }
});

test('reintroduced findings fail the configured blocking ratchet and improvements stay proposals', () => {
  const repository = makeEmptyRepository();
  try {
    const finding = { id: 'knip:reintroduced-finding', path: 'src/a.js', line: 1, severity: 'HIGH', message: 'unused export: helper' };
    const first = measuredRun({ runId: 'run-reintro-one', seed: 'c', findings: [finding] });
    const resolved = measuredRun({ runId: 'run-reintro-two', seed: 'd', findings: [] });
    const reintroduced = measuredRun({ runId: 'run-reintro-three', seed: 'e', findings: [finding] });
    for (const [name, value] of [['first.json', first], ['resolved.json', resolved], ['reintroduced.json', reintroduced]]) {
      fs.writeFileSync(path.join(repository, name), JSON.stringify(value, null, 2));
    }
    assert.equal(runCli(repository, ['baseline', 'first.json', '--output', 'baseline.json']).status, 0);
    const improvement = runCli(repository, ['triage', 'resolved.json', '--baseline', 'baseline.json']);
    const improvementSummary = JSON.parse(improvement.stdout);
    assert.equal(improvement.status, 0);
    assert.equal(improvementSummary.qualityGate.proposals[0].type, 'STRICTER_CEILING');
    assert.equal(improvementSummary.qualityGate.proposals[0].action, 'EXPLICIT_REVIEW_REQUIRED');
    assert.equal(runCli(repository, ['baseline', 'resolved.json', '--output', 'baseline.json', '--replace']).status, 0);
    const result = runCli(repository, ['triage', 'reintroduced.json', '--baseline', 'baseline.json']);
    assert.equal(result.status, 2);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.findings[0].lifecycle, 'REINTRODUCED');
    assert.equal(summary.qualityGate.status, 'FAIL');
    assert.equal(summary.qualityGate.newBlockingFindings[0].id, finding.id);
    assert.match(summary.qualityGate.blockedReasons.join(' '), /blocking findings/);
  } finally {
    cleanup(repository);
  }
});

test('scan applies the ratchet to a complete local execution', () => {
  const repository = makeRepository('scan-ratchet-fixture');
  try {
    const binDirectory = path.join(repository, 'node_modules', '.bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    const writeScanner = (name, json) => {
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDirectory, `${name}.cmd`), `@echo ${json}\r\n@exit /b 0\r\n`);
      } else {
        const file = path.join(binDirectory, name);
        fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${json}'\nexit 0\n`);
        fs.chmodSync(file, 0o755);
      }
    };
    writeScanner('knip', '{"issues":[{"file":"src.js","exports":[{"name":"old","line":1,"severity":"HIGH"}]}]}');
    writeScanner('jscpd', '{"duplicates":[]}');
    initializeGit(repository);
    assert.equal(runCli(repository, ['scan', '--run=knip,jscpd', '--output', 'initial.json']).status, 0);
    assert.equal(runCli(repository, ['baseline', 'initial.json', '--output', 'baseline.json']).status, 0);
    fs.rmSync(path.join(repository, 'initial.json'), { force: true });
    const baselineAdd = spawnSync('git', ['add', '-f', 'baseline.json'], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(baselineAdd.status, 0, baselineAdd.stderr);
    const baselineCommit = spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(baselineCommit.status, 0, baselineCommit.stderr);

    writeScanner('knip', '{"issues":[{"file":"src.js","exports":[{"name":"new","line":1,"severity":"HIGH"}]}]}');
    const changedScanner = spawnSync('git', ['add', '-f', process.platform === 'win32' ? 'node_modules/.bin/knip.cmd' : 'node_modules/.bin/knip'], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(changedScanner.status, 0, changedScanner.stderr);
    const scannerCommit = spawnSync('git', ['commit', '-qm', 'new-finding'], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(scannerCommit.status, 0, scannerCommit.stderr);

    const result = runCli(repository, ['scan', '--run=knip,jscpd', '--baseline', 'baseline.json', '--output', 'current.json']);
    assert.equal(result.status, 2);
    const run = JSON.parse(fs.readFileSync(path.join(repository, 'current.json'), 'utf8'));
    assert.equal(run.comparison.status, 'COMPATIBLE');
    assert.equal(run.qualityGate.status, 'FAIL');
    assert.equal(run.findings[0].lifecycle, 'NEW');
    assert.equal(run.engines.every((engine) => engine.sourceRevision.status === 'VERIFIED'), true);
  } finally {
    cleanup(repository);
  }
});

test('baseline replacement rejects a relaxed ceiling instead of ratifying it', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({ runId: 'run-policy-baseline', seed: '2', findings: [] });
    fs.writeFileSync(path.join(repository, 'run.json'), JSON.stringify(run, null, 2));
    assert.equal(runCli(repository, ['baseline', 'run.json', '--output', 'baseline.json']).status, 0);
    fs.writeFileSync(path.join(repository, 'quality-audit-kit.config.json'), JSON.stringify({
      quality: { ratchet: { blockingSeverities: ['HIGH', 'CRITICAL'], maxNewBlockingFindings: 1, maxMeasuredFindings: null } },
    }, null, 2));
    const result = runCli(repository, ['baseline', 'run.json', '--output', 'baseline.json', '--replace']);
    assert.equal(result.status, 2);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'POLICY_RELAXATION_BLOCKED');
    assert.match(summary.reasons.join(' '), /maxNewBlockingFindings/);
  } finally {
    cleanup(repository);
  }
});

test('incomplete audits are not comparable and cannot imply resolution', () => {
  const repository = makeEmptyRepository();
  try {
    const complete = measuredRun({
      runId: 'run-complete',
      seed: 'f',
      findings: [{ id: 'knip:incomplete-finding', path: 'src/a.js', message: 'unused export: helper' }],
    });
    const incomplete = measuredRun({
      runId: 'run-incomplete',
      seed: '0',
      findings: [],
      measurementStatus: 'NOT_MEASURED',
      sourceStatus: 'UNKNOWN',
    });
    fs.writeFileSync(path.join(repository, 'complete.json'), JSON.stringify(complete, null, 2));
    fs.writeFileSync(path.join(repository, 'incomplete.json'), JSON.stringify(incomplete, null, 2));
    assert.equal(runCli(repository, ['baseline', 'complete.json', '--output', 'baseline.json']).status, 0);
    const result = runCli(repository, ['triage', 'incomplete.json', '--baseline', 'baseline.json']);
    assert.equal(result.status, 2);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'NOT_EVALUATED');
    assert.equal(summary.comparison.status, 'NOT_EVALUATED');
    assert.equal(summary.comparison.resolved.length, 0);
  } finally {
    cleanup(repository);
  }
});

test('triage records the four supported decisions with evidence and stale control', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({
      runId: 'run-triage-decision',
      seed: '1',
      findings: [{ id: 'knip:triage-finding', path: 'src/a.js', message: 'unused export: helper' }],
    });
    fs.writeFileSync(path.join(repository, 'run.json'), JSON.stringify(run, null, 2));
    const written = runCli(repository, [
      'triage', 'run.json', '--decisions', 'decisions.json', '--finding', 'knip:triage-finding',
      '--decision', 'KEEP_JUSTIFIED', '--reason', 'Documented public compatibility surface.',
      '--reviewer', 'reviewer', '--reviewed-revision', measuredRevision('1').sha,
      '--review-after', '2026-10-23', '--evidence', 'SOURCE_INSPECTION|docs/contracts.md|PASS',
    ]);
    assert.equal(written.status, 2, written.stderr);
    const decisions = JSON.parse(fs.readFileSync(path.join(repository, 'decisions.json'), 'utf8'));
    assert.equal(decisions.decisions[0].decision, 'KEEP_JUSTIFIED');
    assert.equal(decisions.decisions[0].evidence[0].reference, 'docs/contracts.md');
    assert.match(JSON.parse(written.stdout).decisions[0].status, /STALE/);
  } finally {
    cleanup(repository);
  }
});

test('plan groups only evidenced common causes, orders lots and exports Codex prompts', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({
      runId: 'plan-run-0001',
      seed: 'f',
      findings: [
        { id: 'plan-security-001', path: 'src/auth.js', severity: 'CRITICAL', message: 'confirmed security boundary' },
        { id: 'plan-shared-001', path: 'src/validator.js', severity: 'HIGH', message: 'validator branch one' },
        { id: 'plan-shared-002', path: 'src/validator.js', severity: 'MEDIUM', message: 'validator branch two' },
        { id: 'plan-debt-001', path: 'src/consumer.js', severity: 'LOW', message: 'actionable debt' },
        { id: 'plan-uncertain-1', path: 'src/unknown.js', severity: 'INFO', message: 'uncertain observation' },
        { id: 'plan-justified-1', path: 'src/legacy.js', severity: 'LOW', message: 'accepted exception' },
      ],
    });
    run.findings[0].securityConfirmed = true;
    run.findings[0].responsibility = 'security';
    for (const finding of run.findings.slice(1, 3)) {
      finding.planCategory = 'STRUCTURAL_CAUSE';
      finding.commonCauseId = 'shared-validator';
      finding.commonCauseEvidence = 'Both findings are emitted by the same validator contract and the same owner confirmed one repair point.';
      finding.responsibility = 'validation';
      finding.consumers = ['src/consumer.js', 'tests/validator.test.js'];
      finding.changeRisk = 'MEDIUM';
      finding.estimatedCost = 'LOW';
    }
    run.findings[3].planCategory = 'ACTIONABLE_DEBT';
    run.findings[3].dependsOnCauseId = 'shared-validator';
    run.findings[3].responsibility = 'consumer';
    run.findings[5].lifecycle = 'HISTORICAL_JUSTIFIED';
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    fs.writeFileSync(path.join(repository, 'decisions.json'), JSON.stringify({ schemaVersion: '0.1-draft', decisions: [{ findingId: 'plan-justified-1', decision: 'KEEP_JUSTIFIED', reason: 'accepted exception', reviewer: 'reviewer', reviewedRevision: 'f'.repeat(40), evidence: [{ type: 'STATIC_CONTRACT', reference: 'docs/legacy.md', outcome: 'PASS' }] }] }, null, 2));

    const created = runCli(repository, ['plan', 'run.json', '--decisions', 'decisions.json', '--output', 'plan.json', '--markdown', 'plan.md']);
    assert.equal(created.status, 0, created.stderr);
    const plan = JSON.parse(fs.readFileSync(path.join(repository, 'plan.json'), 'utf8'));
    assert.equal(plan.status, 'NEEDS_TRIAGE');
    assert.equal(plan.ordering.noOpaqueScore, true);
    assert.equal(Object.hasOwn(plan, 'score'), false);
    const sharedLots = plan.lots.filter((lot) => lot.findings.some((finding) => ['plan-shared-001', 'plan-shared-002'].includes(finding.id)));
    assert.equal(sharedLots.length, 1);
    assert.equal(sharedLots[0].findings.length, 2);
    const debtLot = plan.lots.find((lot) => lot.findings.some((finding) => finding.id === 'plan-debt-001'));
    assert.deepEqual(debtLot.dependencies, [sharedLots[0].id]);
    assert.equal(plan.excludedFindings.some((finding) => finding.findingId === 'plan-justified-1'), true);
    assert.equal(plan.prompts.every((prompt) => /Objective|Invariants|Verification|Stop condition/.test(prompt.content)), true);
    assert.match(fs.readFileSync(path.join(repository, 'plan.md'), 'utf8'), /Correction lots/);

    const repeated = runCli(repository, ['plan', 'run.json', '--decisions', 'decisions.json', '--output', 'plan-repeat.json', '--markdown', 'plan-repeat.md']);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repository, 'plan-repeat.json'), 'utf8')), plan);

    const next = runCli(repository, ['plan', '--next', 'plan.json']);
    assert.equal(next.status, 0, next.stderr);
    const nextResult = JSON.parse(next.stdout);
    assert.equal(nextResult.status, 'READY');
    assert.equal(nextResult.lot.category, 'SECURITY_CONFIRMED');

    const exported = runCli(repository, ['plan', '--export', 'plan.json', '--output', 'prompts']);
    assert.equal(exported.status, 0, exported.stderr);
    const exportedSummary = JSON.parse(exported.stdout);
    assert.equal(exportedSummary.files.length, plan.prompts.length);
    assert.equal(fs.readdirSync(path.join(repository, 'prompts')).length, plan.prompts.length);
  } finally {
    cleanup(repository);
  }
});

test('plan export validates prompt paths before writing and preserves destination protections', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({ runId: 'plan-export-0001', seed: 'a', findings: [{ id: 'plan-export-finding', path: 'src/a.js', message: 'export fixture' }] });
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    const created = runCli(repository, ['plan', 'run.json', '--output', 'plan.json', '--markdown', 'plan.md']);
    assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
    const planPath = path.join(repository, 'plan.json');
    const originalPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    const valid = runCli(repository, ['plan', '--export', 'plan.json', '--output', 'prompts-valid']);
    assert.equal(valid.status, 0, `${valid.stderr}\n${valid.stdout}`);
    assert.equal(fs.readdirSync(path.join(repository, 'prompts-valid')).length, originalPlan.prompts.length);

    const unsafeNames = ['../outside.md', '../../outside.md', '/tmp/outside.md', 'C:\\outside.md', 'sub\\prompt.md', 'sub/prompt.md'];
    for (const [index, fileName] of unsafeNames.entries()) {
      const modified = JSON.parse(JSON.stringify(originalPlan));
      modified.prompts[0].fileName = fileName;
      const modifiedPath = path.join(repository, `unsafe-${index}.json`);
      fs.writeFileSync(modifiedPath, `${JSON.stringify(modified, null, 2)}\n`);
      const exportDirectory = path.join(repository, `unsafe-${index}`);
      const rejected = runCli(repository, ['plan', '--export', path.basename(modifiedPath), '--output', path.basename(exportDirectory)]);
      assert.notEqual(rejected.status, 0, fileName);
      assert.equal(fs.existsSync(path.join(repository, 'outside.md')), false);
      assert.equal(fs.existsSync(path.join(repository, 'tmp', 'outside.md')), false);
      assert.equal(fs.existsSync(exportDirectory), false);
    }

    const duplicate = JSON.parse(JSON.stringify(originalPlan));
    duplicate.prompts.push({ ...duplicate.prompts[0], lotId: duplicate.prompts[0].lotId, priority: duplicate.prompts[0].priority + 1 });
    const duplicatePath = path.join(repository, 'duplicate.json');
    fs.writeFileSync(duplicatePath, `${JSON.stringify(duplicate, null, 2)}\n`);
    const duplicateExport = runCli(repository, ['plan', '--export', 'duplicate.json', '--output', 'prompts-duplicate']);
    assert.notEqual(duplicateExport.status, 0);
    assert.equal(fs.existsSync(path.join(repository, 'prompts-duplicate')), false);

    const malformed = { planType: 'QUALITY_CORRECTION_PLAN', lots: [] };
    fs.writeFileSync(path.join(repository, 'malformed.json'), `${JSON.stringify(malformed)}\n`);
    const malformedExport = runCli(repository, ['plan', '--export', 'malformed.json', '--output', 'prompts-malformed']);
    assert.notEqual(malformedExport.status, 0);
    const malformedNext = runCli(repository, ['plan', '--next', 'malformed.json']);
    assert.notEqual(malformedNext.status, 0);
    assert.equal(fs.existsSync(path.join(repository, 'prompts-malformed')), false);

    const existing = JSON.parse(JSON.stringify(originalPlan));
    const existingPath = path.join(repository, 'existing.json');
    fs.writeFileSync(existingPath, `${JSON.stringify(existing, null, 2)}\n`);
    const protectedDirectory = path.join(repository, 'prompts-existing');
    fs.mkdirSync(protectedDirectory);
    const protectedPath = path.join(protectedDirectory, existing.prompts[0].fileName);
    fs.writeFileSync(protectedPath, 'human-owned prompt\n');
    const protectedExport = runCli(repository, ['plan', '--export', 'existing.json', '--output', 'prompts-existing']);
    assert.notEqual(protectedExport.status, 0);
    assert.equal(fs.readFileSync(protectedPath, 'utf8'), 'human-owned prompt\n');

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-prompt-outside-'));
    try {
      const symlinkDirectory = path.join(repository, 'prompts-symlink');
      fs.symlinkSync(outside, symlinkDirectory, 'junction');
      const symlinkExport = runCli(repository, ['plan', '--export', 'plan.json', '--output', 'prompts-symlink']);
      assert.notEqual(symlinkExport.status, 0);
      assert.equal(fs.readdirSync(outside).length, 0);
    } finally {
      cleanup(outside);
    }
  } finally {
    cleanup(repository);
  }
});

test('plan exposes dependency cycles and does not merge unsupported relations', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({
      runId: 'plan-run-0002',
      seed: '1',
      findings: [
        { id: 'plan-cycle-a', path: 'src/a.js', severity: 'HIGH', message: 'cycle a' },
        { id: 'plan-cycle-b', path: 'src/b.js', severity: 'HIGH', message: 'cycle b' },
        { id: 'plan-same-owner-a', path: 'src/c.js', severity: 'MEDIUM', message: 'same owner but no cause evidence' },
        { id: 'plan-same-owner-b', path: 'src/d.js', severity: 'MEDIUM', message: 'same owner but no cause evidence' },
      ],
    });
    run.findings[0].planCategory = 'ACTIONABLE_DEBT';
    run.findings[0].dependsOn = ['plan-cycle-b'];
    run.findings[1].planCategory = 'ACTIONABLE_DEBT';
    run.findings[1].dependsOn = ['plan-cycle-a'];
    run.findings[2].planCategory = 'ACTIONABLE_DEBT';
    run.findings[2].responsibility = 'same-owner';
    run.findings[3].planCategory = 'ACTIONABLE_DEBT';
    run.findings[3].responsibility = 'same-owner';
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    const created = runCli(repository, ['plan', 'run.json', '--output', 'plan.json']);
    assert.equal(created.status, 0, created.stderr);
    const plan = JSON.parse(fs.readFileSync(path.join(repository, 'plan.json'), 'utf8'));
    assert.equal(plan.status, 'NEEDS_REVIEW');
    assert.equal(plan.dependencyCycles.length, 1);
    assert.equal(plan.lots.filter((lot) => lot.status === 'CYCLE_REQUIRES_REVIEW').length, 2);
    assert.equal(plan.lots.filter((lot) => lot.findings.some((finding) => finding.id.startsWith('plan-same-owner'))).length, 2);

    const next = runCli(repository, ['plan', '--next', 'plan.json']);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).status, 'NEEDS_REVIEW');
  } finally {
    cleanup(repository);
  }
});

test('thresholds recommend separates current measurements, objectives and ratchet caps', () => {
  const repository = makeRepository('threshold-fixture');
  try {
    const run = measuredRun({ runId: 'threshold-run-001', seed: 'a' });
    run.metrics = [
      {
        name: 'duplication_ratio',
        values: [4, 8, 12, 6],
        unit: 'percent',
        status: 'MEASURED',
        direction: 'LOWER_IS_BETTER',
        language: 'javascript',
        workspace: 'packages/app',
        fileCategory: 'runtime',
        findingCount: 3,
      },
      {
        name: 'generated_warnings',
        values: [1, 2, 3, 4],
        unit: 'findings',
        status: 'MEASURED',
        fileCategory: 'generated',
      },
      {
        name: 'tiny_sample',
        value: 1,
        unit: 'findings',
        status: 'MEASURED',
        fileCategory: 'tests',
      },
    ];
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    fs.writeFileSync(path.join(repository, 'baseline.json'), `${JSON.stringify({
      runId: 'baseline-001',
      thresholds: { metrics: [{ name: 'duplication_ratio', unit: 'percent', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'packages/app', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 10 }] },
    }, null, 2)}\n`);

    const result = runCli(repository, ['thresholds', 'recommend', 'run.json', '--baseline', 'baseline.json', '--output', 'recommendations.json', '--export', 'proposed.json', '--profile', 'balanced']);
    assert.equal(result.status, 0, result.stderr);
    const recommendation = JSON.parse(fs.readFileSync(path.join(repository, 'recommendations.json'), 'utf8'));
    const runtime = recommendation.proposals.filter((proposal) => proposal.metric.name === 'duplication_ratio');
    assert.deepEqual(new Set(runtime.map((proposal) => proposal.profile)), new Set(['progressive', 'balanced', 'strict']));
    assert(runtime.every((proposal) => proposal.currentMeasurement.distribution.q95 !== undefined));
    assert(runtime.every((proposal) => proposal.historicalRatchetCap.status === 'KNOWN'));
    assert(runtime.every((proposal) => proposal.consequences.requiresExplicitApproval === true));
    assert(runtime.every((proposal) => proposal.findingCount === 3));
    assert(runtime.every((proposal) => proposal.recommendedObjective?.value <= 10));
    assert(recommendation.noGlobalQualityScore);

    const generated = recommendation.proposals.filter((proposal) => proposal.metric.name === 'generated_warnings');
    assert(generated.every((proposal) => proposal.status === 'EXCLUDED_BY_DEFAULT'));
    assert(generated.every((proposal) => proposal.recommendedObjective === null));
    const insufficient = recommendation.proposals.filter((proposal) => proposal.metric.name === 'tiny_sample');
    assert(insufficient.every((proposal) => proposal.status === 'INSUFFICIENT_DATA'));
    assert(insufficient.every((proposal) => proposal.recommendedObjective === null));

    const exported = JSON.parse(fs.readFileSync(path.join(repository, 'proposed.json'), 'utf8'));
    assert.equal(exported.kind, 'QUALITY_THRESHOLDS_PROPOSAL');
    assert.equal(exported.approvalRequired, true);
    assert.equal(exported.profile, 'balanced');
    assert.equal(fs.existsSync(path.join(repository, 'quality-audit-kit.config.json')), false);

    const refused = runCli(repository, ['thresholds', 'recommend', 'run.json', '--apply']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /--approve/);
    assert.equal(fs.existsSync(path.join(repository, 'quality-audit-kit.config.json')), false);

    const applied = runCli(repository, ['thresholds', 'recommend', 'run.json', '--apply', '--approve', '--profile', 'strict']);
    assert.equal(applied.status, 0, applied.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(repository, 'quality-audit-kit.config.json'), 'utf8'));
    assert.equal(config.quality.thresholds.profile, 'strict');
    assert.equal(config.quality.thresholds.approval.kind, 'EXPLICIT_CLI_APPROVAL');
  } finally {
    cleanup(repository);
  }
});

test('thresholds require an explicit metric direction and measured engine evidence', () => {
  const repository = makeEmptyRepository();
  try {
    const unknownDirection = measuredRun({ runId: 'threshold-direction-unknown-001', seed: 'u' });
    unknownDirection.metrics = [{ name: 'test_coverage', values: [70, 80, 90, 100], unit: 'percent', status: 'MEASURED', language: 'javascript', workspace: 'root', fileCategory: 'runtime' }];
    fs.writeFileSync(path.join(repository, 'unknown.json'), `${JSON.stringify(unknownDirection, null, 2)}\n`);
    const unknownFirst = runCli(repository, ['thresholds', 'recommend', 'unknown.json']);
    const unknownSecond = runCli(repository, ['thresholds', 'recommend', 'unknown.json']);
    assert.equal(unknownFirst.status, 0, unknownFirst.stderr);
    assert.equal(unknownSecond.status, 0, unknownSecond.stderr);
    assert.equal(unknownFirst.stdout, unknownSecond.stdout);
    const unknownRecommendation = JSON.parse(unknownFirst.stdout);
    assert.equal(unknownRecommendation.series[0].metric.direction, 'DIRECTION_UNKNOWN');
    assert.equal(unknownRecommendation.series[0].directionStatus, 'UNKNOWN');
    assert(unknownRecommendation.proposals.every((proposal) => proposal.status === 'DIRECTION_UNKNOWN'));
    assert(unknownRecommendation.proposals.every((proposal) => proposal.recommendedObjective === null));

    const configPath = path.join(repository, 'quality-audit-kit.config.json');
    const initialConfig = { quality: { thresholds: { ratchet: { metrics: [{ metric: 'existing', unit: 'count', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 1 }] } } } };
    fs.writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
    const beforeUnknownApply = fs.readFileSync(configPath, 'utf8');
    const unknownApply = runCli(repository, ['thresholds', 'recommend', 'unknown.json', '--apply', '--approve']);
    assert.notEqual(unknownApply.status, 0);
    assert.match(unknownApply.stderr, /direction|unknown/i);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeUnknownApply);

    const validDirections = measuredRun({ runId: 'threshold-direction-valid-001', seed: 'v' });
    validDirections.metrics = [
      { name: 'test_coverage', values: [70, 80, 90, 100], unit: 'percent', status: 'MEASURED', direction: 'HIGHER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime' },
      { name: 'duplication_ratio', values: [4, 8, 12, 6], unit: 'percent', status: 'MEASURED', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime' },
    ];
    fs.writeFileSync(path.join(repository, 'valid-directions.json'), `${JSON.stringify(validDirections, null, 2)}\n`);
    const validResult = runCli(repository, ['thresholds', 'recommend', 'valid-directions.json']);
    assert.equal(validResult.status, 0, validResult.stderr);
    const validRecommendation = JSON.parse(validResult.stdout);
    const strictCoverage = validRecommendation.proposals.find((proposal) => proposal.metric.name === 'test_coverage' && proposal.profile === 'strict');
    const strictDuplication = validRecommendation.proposals.find((proposal) => proposal.metric.name === 'duplication_ratio' && proposal.profile === 'strict');
    assert.equal(strictCoverage.recommendedObjective.value, 100);
    assert.equal(strictDuplication.recommendedObjective.value, 4);

    const zeroEngines = measuredRun({ runId: 'threshold-no-engine-001', seed: 'z', findings: [{ id: 'finding-no-engine', path: 'src/a.js', message: 'no engine' }] });
    zeroEngines.engines = [];
    fs.writeFileSync(path.join(repository, 'zero-engines.json'), `${JSON.stringify(zeroEngines, null, 2)}\n`);
    const zeroEnginesResult = runCli(repository, ['thresholds', 'recommend', 'zero-engines.json']);
    assert.equal(zeroEnginesResult.status, 0, zeroEnginesResult.stderr);
    const zeroEnginesRecommendation = JSON.parse(zeroEnginesResult.stdout);
    assert.equal(zeroEnginesRecommendation.status, 'INSUFFICIENT_DATA');
    assert.equal(zeroEnginesRecommendation.measurement.derivedFindingSeriesCount, 0);
    assert(zeroEnginesRecommendation.measurement.warnings.some((warning) => warning.status === 'ENGINE_NOT_DECLARED'));

    const failedEngine = measuredRun({ runId: 'threshold-failed-engine-001', seed: 'f', findings: [{ id: 'finding-failed-engine', path: 'src/a.js', message: 'failed engine' }] });
    failedEngine.engines[0].measurementStatus = 'FAILURE';
    fs.writeFileSync(path.join(repository, 'failed-engine.json'), `${JSON.stringify(failedEngine, null, 2)}\n`);
    const failedEngineResult = runCli(repository, ['thresholds', 'recommend', 'failed-engine.json']);
    assert.equal(failedEngineResult.status, 0, failedEngineResult.stderr);
    const failedEngineRecommendation = JSON.parse(failedEngineResult.stdout);
    assert.equal(failedEngineRecommendation.measurement.derivedFindingSeriesCount, 0);
    assert(failedEngineRecommendation.measurement.warnings.some((warning) => warning.source === 'engine' && warning.status === 'FAILURE'));

    const measuredFinding = measuredRun({ runId: 'threshold-measured-engine-001', seed: 'm', findings: [{ id: 'finding-measured-engine', path: 'src/a.js', message: 'measured engine' }] });
    fs.writeFileSync(path.join(repository, 'measured-engine.json'), `${JSON.stringify(measuredFinding, null, 2)}\n`);
    const measuredFindingResult = runCli(repository, ['thresholds', 'recommend', 'measured-engine.json']);
    assert.equal(measuredFindingResult.status, 0, measuredFindingResult.stderr);
    const measuredFindingRecommendation = JSON.parse(measuredFindingResult.stdout);
    assert.equal(measuredFindingRecommendation.measurement.derivedFindingSeriesCount, 1);
    assert.equal(measuredFindingRecommendation.series[0].metric.name, 'finding_count');

    const notMeasuredFinding = measuredRun({ runId: 'threshold-not-measured-finding-001', seed: 'n', findings: [{ id: 'finding-not-measured', path: 'src/a.js', message: 'not measured' }] });
    notMeasuredFinding.findings[0].measurementStatus = 'NOT_MEASURED';
    fs.writeFileSync(path.join(repository, 'not-measured-finding.json'), `${JSON.stringify(notMeasuredFinding, null, 2)}\n`);
    const notMeasuredResult = runCli(repository, ['thresholds', 'recommend', 'not-measured-finding.json']);
    assert.equal(notMeasuredResult.status, 0, notMeasuredResult.stderr);
    const notMeasuredRecommendation = JSON.parse(notMeasuredResult.stdout);
    assert.equal(notMeasuredRecommendation.status, 'INSUFFICIENT_DATA');
    assert.equal(notMeasuredRecommendation.measurement.derivedFindingSeriesCount, 0);
    assert(notMeasuredRecommendation.measurement.warnings.some((warning) => warning.source === 'finding' && warning.status === 'NOT_MEASURED'));
  } finally {
    cleanup(repository);
  }
});

test('thresholds recommend exposes atypical, absent and inferred category measurements without inventing cleanliness', () => {
  const repository = makeEmptyRepository();
  try {
    const degraded = measuredRun({ runId: 'threshold-degraded-001', seed: 'b' });
    degraded.qualityState = 'DEGRADED';
    degraded.metrics = [{ name: 'errors', values: [1, 2, 100, 120], unit: 'findings', status: 'MEASURED', language: 'javascript', workspace: 'root', fileCategory: 'runtime' }];
    fs.writeFileSync(path.join(repository, 'degraded.json'), `${JSON.stringify(degraded, null, 2)}\n`);
    const degradedResult = runCli(repository, ['thresholds', 'recommend', 'degraded.json']);
    assert.equal(degradedResult.status, 0, degradedResult.stderr);
    const degradedRecommendation = JSON.parse(degradedResult.stdout);
    assert(degradedRecommendation.proposals.every((proposal) => proposal.status === 'REVIEW_REQUIRED'));
    assert(degradedRecommendation.proposals.every((proposal) => proposal.recommendedObjective === null));
    assert(degradedRecommendation.series[0].distribution.q95 > degradedRecommendation.series[0].distribution.q50);

    const incomplete = measuredRun({ runId: 'threshold-incomplete-001', seed: 'c', measurementStatus: 'FAILURE' });
    fs.writeFileSync(path.join(repository, 'incomplete.json'), `${JSON.stringify(incomplete, null, 2)}\n`);
    const incompleteResult = runCli(repository, ['thresholds', 'recommend', 'incomplete.json']);
    assert.equal(incompleteResult.status, 0, incompleteResult.stderr);
    const incompleteRecommendation = JSON.parse(incompleteResult.stdout);
    assert.equal(incompleteRecommendation.status, 'INSUFFICIENT_DATA');
    assert(incompleteRecommendation.measurement.warnings.some((warning) => warning.status === 'FAILURE'));

    const categorized = measuredRun({
      runId: 'threshold-categories-001',
      seed: 'd',
      findings: [
        { id: 'finding-runtime-001', path: 'src/main.js', message: 'runtime' },
        { id: 'finding-tests-001', path: 'tests/main.test.js', message: 'tests' },
        { id: 'finding-config-001', path: 'config/settings.json', message: 'configuration' },
        { id: 'finding-generated-001', path: 'dist/generated.js', message: 'generated' },
      ],
    });
    fs.writeFileSync(path.join(repository, 'categorized.json'), `${JSON.stringify(categorized, null, 2)}\n`);
    const categorizedResult = runCli(repository, ['thresholds', 'recommend', 'categorized.json']);
    assert.equal(categorizedResult.status, 0, categorizedResult.stderr);
    const categorizedRecommendation = JSON.parse(categorizedResult.stdout);
    assert.deepEqual(new Set(categorizedRecommendation.series.map((series) => series.dimensions.fileCategory)), new Set(['runtime', 'tests', 'configuration', 'generated']));
    assert(categorizedRecommendation.proposals.filter((proposal) => proposal.dimensions.fileCategory === 'generated').every((proposal) => proposal.status === 'EXCLUDED_BY_DEFAULT'));
  } finally {
    cleanup(repository);
  }
});

test('threshold application preserves the strictest ratchet, dimensions and unrelated policy fields', () => {
  const repository = makeEmptyRepository();
  try {
    const run = measuredRun({ runId: 'threshold-ratchet-001', seed: '1' });
    run.metrics = [
      { name: 'latency', values: [8, 8, 8, 8], unit: 'ms', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime' },
      { name: 'latency', values: [80, 80, 80, 80], unit: 'ms', direction: 'LOWER_IS_BETTER', language: 'python', workspace: 'root', fileCategory: 'runtime' },
      { name: 'coverage', values: [65, 65, 65, 65], unit: 'percent', direction: 'HIGHER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime' },
    ];
    fs.writeFileSync(path.join(repository, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    fs.writeFileSync(path.join(repository, 'baseline.json'), `${JSON.stringify({
      runId: 'threshold-baseline-001',
      thresholds: { metrics: [
        { name: 'latency', unit: 'ms', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 10 },
        { name: 'latency', unit: 'ms', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 6 },
        { name: 'latency', unit: 'ms', direction: 'LOWER_IS_BETTER', language: 'python', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 100 },
        { name: 'coverage', unit: 'percent', direction: 'HIGHER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 60 },
      ] },
    }, null, 2)}\n`);
    const initialConfig = {
      projectField: 'preserve-project-field',
      quality: {
        unrelatedQualityField: 'preserve-quality-field',
        thresholds: {
          userField: 'preserve-threshold-field',
          profile: 'old',
          ratchet: {
            userRatchetField: 'preserve-ratchet-field',
            metrics: [
              { metric: 'latency', unit: 'ms', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 1 },
              { metric: 'coverage', unit: 'percent', direction: 'HIGHER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'runtime', scope: 'COMMITTED_SNAPSHOT', value: 70 },
              { metric: 'unrelated', unit: 'count', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'root', fileCategory: 'tests', scope: 'COMMITTED_SNAPSHOT', value: 42 },
            ],
          },
          approval: { priorDecision: 'retain-me' },
        },
      },
    };
    const configPath = path.join(repository, 'quality-audit-kit.config.json');
    fs.writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
    const beforeApproval = fs.readFileSync(configPath, 'utf8');

    const withoutApproval = runCli(repository, ['thresholds', 'recommend', 'run.json', '--baseline', 'baseline.json', '--apply', '--profile', 'balanced']);
    assert.notEqual(withoutApproval.status, 0);
    assert.match(withoutApproval.stderr, /--approve/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeApproval);

    const recommendationRun = runCli(repository, ['thresholds', 'recommend', 'run.json', '--baseline', 'baseline.json']);
    assert.equal(recommendationRun.status, 0, recommendationRun.stderr);
    const recommendation = JSON.parse(recommendationRun.stdout);
    const javascriptLatency = recommendation.proposals.find((proposal) => proposal.metric.name === 'latency' && proposal.dimensions.language === 'javascript' && proposal.profile === 'balanced');
    const pythonLatency = recommendation.proposals.find((proposal) => proposal.metric.name === 'latency' && proposal.dimensions.language === 'python' && proposal.profile === 'balanced');
    const coverage = recommendation.proposals.find((proposal) => proposal.metric.name === 'coverage' && proposal.profile === 'balanced');
    assert.equal(javascriptLatency.statisticalProposal.value, 8);
    assert.equal(javascriptLatency.recommendedObjective.value, 1);
    assert.deepEqual(new Set(javascriptLatency.historicalRatchetCap.candidates.map((candidate) => candidate.value)), new Set([1, 6, 10]));
    assert.equal(pythonLatency.historicalRatchetCap.value, 100);
    assert.equal(pythonLatency.recommendedObjective.value, 80);
    assert.equal(coverage.historicalRatchetCap.value, 70);
    assert.equal(coverage.recommendedObjective.value, 70);

    const applied = runCli(repository, ['thresholds', 'recommend', 'run.json', '--baseline', 'baseline.json', '--apply', '--approve', '--profile', 'balanced']);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(appliedConfig.projectField, 'preserve-project-field');
    assert.equal(appliedConfig.quality.unrelatedQualityField, 'preserve-quality-field');
    assert.equal(appliedConfig.quality.thresholds.userField, 'preserve-threshold-field');
    assert.equal(appliedConfig.quality.thresholds.ratchet.userRatchetField, 'preserve-ratchet-field');
    assert.equal(appliedConfig.quality.thresholds.approval.priorDecision, 'retain-me');
    assert.equal(appliedConfig.quality.thresholds.ratchet.metrics.find((metric) => metric.metric === 'latency' && metric.language === 'javascript').value, 1);
    assert.equal(appliedConfig.quality.thresholds.ratchet.metrics.find((metric) => metric.metric === 'coverage').value, 70);
    assert.equal(appliedConfig.quality.thresholds.ratchet.metrics.find((metric) => metric.metric === 'unrelated').value, 42);

    const stricterConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    stricterConfig.quality.thresholds.ratchet.metrics.find((metric) => metric.metric === 'latency' && metric.language === 'javascript').value = 10;
    fs.writeFileSync(configPath, `${JSON.stringify(stricterConfig, null, 2)}\n`);
    const stricter = runCli(repository, ['thresholds', 'recommend', 'run.json', '--apply', '--approve', '--profile', 'balanced']);
    assert.equal(stricter.status, 0, stricter.stderr);
    const stricterApplied = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(stricterApplied.quality.thresholds.ratchet.metrics.find((metric) => metric.metric === 'latency' && metric.language === 'javascript').value, 8);

    const invalidConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    invalidConfig.quality.thresholds.ratchet.metrics[0].value = 'not-a-number';
    fs.writeFileSync(configPath, `${JSON.stringify(invalidConfig, null, 2)}\n`);
    const beforeInvalidApply = fs.readFileSync(configPath, 'utf8');
    const invalidApply = runCli(repository, ['thresholds', 'recommend', 'run.json', '--apply', '--approve']);
    assert.notEqual(invalidApply.status, 0);
    assert.match(invalidApply.stderr, /invalid|mutation/i);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeInvalidApply);
  } finally {
    cleanup(repository);
  }
});

test('fix --next previews without mutation and an authorized deterministic cycle resolves with redacted proof', async () => {
  const repository = makeRepository('fix-cycle-fixture');
  try {
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src', 'fix-target.js'), 'module.exports = "QAK_FIX_ME";\n');
    initializeGit(repository);
    const run = measuredRun({
      runId: 'fix-run-0001',
      seed: 'e',
      findings: [{ id: 'fix-target-001', path: 'src/fix-target.js', ruleId: 'unused-export', message: 'deterministic fixture finding', severity: 'MEDIUM' }],
    });
    run.findings[0].lifecycle = 'NEW';
    const plan = buildPlan(run);
    fs.writeFileSync(path.join(repository, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

    const preview = runCli(repository, ['fix', '--next', 'plan.json']);
    assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
    const previewResult = JSON.parse(preview.stdout);
    assert.equal(previewResult.mode, 'PREVIEW');
    assert.equal(previewResult.status, 'READY');
    assert.equal(previewResult.authorization.received, false);
    assert.equal(fs.readFileSync(path.join(repository, 'src', 'fix-target.js'), 'utf8'), 'module.exports = "QAK_FIX_ME";\n');

    const blocked = runCli(repository, ['fix', '--next', 'plan.json', '--execute', '--agent', 'deterministic']);
    assert.equal(blocked.status, 2);
    const blockedResult = JSON.parse(blocked.stdout);
    assert.equal(blockedResult.status, 'BLOCKED');
    assert.match(blockedResult.reason, /--approve/);
    assert.equal(fs.readFileSync(path.join(repository, 'src', 'fix-target.js'), 'utf8'), 'module.exports = "QAK_FIX_ME";\n');

    const next = nextLot(plan);
    const result = await executeFix({
      plan,
      next,
      root: repository,
      agentName: 'deterministic',
      approve: true,
      adapter: createDeterministicAdapter(),
      reanalyze: async () => ({ status: 'MEASURED_VERIFIED', sourceRevisionStatus: 'VERIFIED', remainingFindings: [], engines: [{ name: 'knip', measurementStatus: 'MEASURED', sourceRevision: { status: 'VERIFIED', sha: 'e'.repeat(40) } }] }),
      validate: () => ({ status: 'PASS', validations: [{ name: 'test', status: 'PASS', exitCode: 0 }] }),
    });
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.authorization.received, true);
    assert.deepEqual(result.scopeAudit.foreignChanges, []);
    assert.equal(result.scopeAudit.headChanged, false);
    assert.equal(fs.readFileSync(path.join(repository, 'src', 'fix-target.js'), 'utf8'), 'module.exports = "QAK_FIXED";\n');
    assert.equal(verifyFixResult(result).verified, true);
    assert.doesNotMatch(JSON.stringify(result), /QAK_FIX_ME/);
    fs.writeFileSync(path.join(repository, 'fix-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    const verified = runCli(repository, ['verify', 'fix-result.json']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verified, true);
  } finally {
    cleanup(repository);
  }
});

test('fix refuses to overwrite a pre-existing approved change and verify rejects unverified proof', async () => {
  const repository = makeRepository('fix-preservation-fixture');
  try {
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src', 'fix-target.js'), 'module.exports = "QAK_FIX_ME";\n');
    initializeGit(repository);
    const run = measuredRun({ runId: 'fix-run-0002', seed: 'f', findings: [{ id: 'fix-target-002', path: 'src/fix-target.js', message: 'fixture' }] });
    run.findings[0].lifecycle = 'NEW';
    const plan = buildPlan(run);
    fs.writeFileSync(path.join(repository, 'src', 'fix-target.js'), 'module.exports = "human-change";\n');
    const result = await executeFix({
      plan,
      next: nextLot(plan),
      root: repository,
      approve: true,
      adapter: createDeterministicAdapter(),
      reanalyze: async () => ({ status: 'MEASURED_VERIFIED' }),
      validate: () => ({ status: 'PASS', validations: [] }),
    });
    assert.equal(result.status, 'BLOCKED');
    assert.match(result.reason, /pre-existing changes/);
    assert.equal(fs.readFileSync(path.join(repository, 'src', 'fix-target.js'), 'utf8'), 'module.exports = "human-change";\n');
    assert.equal(verifyFixResult({ ...result, mode: 'EXECUTION' }).verified, false);
  } finally {
    cleanup(repository);
  }
});

test('fix status classification never conflates failed, blocked or unverified evidence with resolution', () => {
  const execution = { status: 'COMPLETED' };
  const scope = { clean: true, headChanged: false, allowedChanges: ['src/file.js'] };
  const passing = { status: 'PASS' };
  assert.equal(classifyExecution({ status: 'FAILED' }, scope, { status: 'MEASURED_VERIFIED' }, passing), 'FAILED');
  assert.equal(classifyExecution(execution, scope, { status: 'BLOCKED' }, passing), 'BLOCKED');
  assert.equal(classifyExecution(execution, scope, { status: 'FINDINGS_REMAIN' }, passing), 'FAILED');
  assert.equal(classifyExecution(execution, scope, { status: 'MEASURED_UNVERIFIED' }, passing), 'UNVERIFIED');
  assert.equal(classifyExecution(execution, scope, { status: 'MEASURED_VERIFIED' }, { status: 'NOT_RUN' }), 'UNVERIFIED');
  assert.equal(classifyExecution(execution, scope, { status: 'MEASURED_VERIFIED' }, passing), 'RESOLVED');
  assert.equal(classifyExecution(execution, { ...scope, clean: false, foreignChanges: [{ path: 'other.js' }] }, { status: 'MEASURED_VERIFIED' }, passing), 'FAILED');
});

test('SARIF 2.1.0 import and export preserve canonical fields and diagnostics', () => {
  const repository = makeEmptyRepository();
  try {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'sample.sarif');
    const imported = importSarifFile(repository, fixture);
    assert.equal(imported.engine.name, 'sarif');
    assert.equal(imported.engine.sourceRevision.status, 'UNVERIFIED');
    assert.equal(imported.findings.length, 2);
    assert.equal(imported.findings[0].path, 'src/app.js');
    assert.equal(imported.findings[0].lifecycle, 'UNCLASSIFIED');
    assert.equal(imported.findings[0].provenance.sourceRevision.sha, 'a'.repeat(40));
    assert.ok(imported.diagnostics.some((item) => item.code === 'FIELD_NOT_REPRESENTABLE'));
    assert.ok(imported.diagnostics.some((item) => item.code === 'LOCATION_NOT_REPRESENTABLE'));
    const run = {
      schemaVersion: '0.1-draft',
      runId: 'sarif-run-0001',
      repository: { name: 'sarif-fixture' },
      inputScope: 'WORKTREE_LIVE',
      reproducible: false,
      engines: [imported.engine],
      findings: imported.findings,
      diagnostics: imported.diagnostics,
    };
    validateRun(run);
    const exported = buildSarif(run);
    assert.equal(exported.version, '2.1.0');
    assert.equal(exported.runs[0].results.length, 2);
    assert.equal(exported.runs[0].results[0].properties.qakLifecycle, 'UNCLASSIFIED');
    assert.equal(exported.runs[0].properties.qakRunId, 'sarif-run-0001');
  } finally {
    cleanup(repository);
  }
});

test('scan and report expose SARIF connector without requiring an account', () => {
  const repository = makeRepository('sarif-cli-fixture');
  try {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'sample.sarif');
    const scan = runCli(repository, ['scan', '--sarif-report', fixture, '--output', 'sarif-run.json']);
    assert.equal(scan.status, 0, `${scan.stderr}\n${scan.stdout}`);
    const run = JSON.parse(fs.readFileSync(path.join(repository, 'sarif-run.json'), 'utf8'));
    assert.equal(run.engines.find((engine) => engine.name === 'sarif').measurementStatus, 'MEASURED');
    const report = runCli(repository, ['report', 'sarif-run.json', '--format', 'sarif', '--output', 'exported.sarif']);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repository, 'exported.sarif'), 'utf8')).version, '2.1.0');
    const imported = runCli(repository, ['import', 'sarif', fixture, '--output', 'imported-run.json']);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repository, 'imported-run.json'), 'utf8')).engines[0].name, 'sarif');
  } finally {
    cleanup(repository);
  }
});

test('SonarQube connector detects version, paginates and keeps analysis revision separate from HEAD', async () => {
  const repository = makeRepository('sonar-fixture');
  try {
    const calls = [];
    const request = async ({ pathname, query, headers }) => {
      calls.push({ pathname, query, headers });
      if (pathname === '/api/server/version') return { status: 200, body: '10.6.0.92116' };
      if (pathname === '/api/issues/search') {
        const page = Number(query.p);
        return { status: 200, body: JSON.stringify({ paging: { total: 3, pageIndex: page, pageSize: Number(query.ps) }, issues: page === 1 ? [
          { key: 'ISSUE-1', rule: 'js:Rule', severity: 'MAJOR', component: 'sonar-fixture:src/a.js', line: 3, message: 'First issue' },
          { key: 'ISSUE-2', rule: 'js:Rule', severity: 'MINOR', component: 'sonar-fixture:src/b.js', textRange: { startLine: 4 }, message: 'Second issue' },
        ] : [{ key: 'ISSUE-3', rule: 'js:Rule', severity: 'INFO', component: 'sonar-fixture:src/c.js', message: 'Third issue', flows: [{ locations: [] }] }] }) };
      }
      if (pathname === '/api/project_analyses/search') return { status: 200, body: JSON.stringify({ analyses: [{ key: 'analysis-1', revision: 'b'.repeat(40), date: '2026-10-24T12:00:00+0000' }] }) };
      throw new Error(`unexpected endpoint ${pathname}`);
    };
    const connected = await connectSonar({ root: repository, url: 'https://sonar.example.invalid', project: 'sonar-fixture', tokenEnv: 'QAK_TEST_TOKEN', env: { QAK_TEST_TOKEN: 'secret-token-value' }, request });
    assert.equal(connected.status, 'CONNECTED');
    assert.equal(connected.version, '10.6.0.92116');
    assert.equal(connected.tokenSource, 'environment:QAK_TEST_TOKEN');
    const imported = await importSonar(repository, { url: 'https://sonar.example.invalid', project: 'sonar-fixture', branch: 'main', tokenEnv: 'QAK_TEST_TOKEN', env: { QAK_TEST_TOKEN: 'secret-token-value' }, request });
    assert.equal(imported.status, 'MEASURED');
    assert.equal(imported.findings.length, 3);
    assert.equal(imported.engine.sourceRevision.sha, 'b'.repeat(40));
    assert.equal(imported.engine.sourceRevision.status, 'UNVERIFIED');
    assert.ok(imported.diagnostics.some((item) => item.code === 'FIELD_NOT_REPRESENTABLE'));
    assert.equal(calls.filter((call) => call.pathname === '/api/issues/search').length, 2);
    assert.equal(calls.find((call) => call.pathname === '/api/issues/search').query.branch, 'main');
    assert.equal(calls.find((call) => call.pathname === '/api/issues/search').headers.authorization, 'Bearer secret-token-value');
    assert.equal(imported.findings.some((finding) => finding.provenance.sourceRevision.sha === 'a'.repeat(40)), false);
    assert.equal(imported.findings.every((finding) => !String(finding.message).includes('secret-token-value')), true);
  } finally {
    cleanup(repository);
  }
});

test('SonarQube connector preserves limits and permission errors without claiming clean', async () => {
  const repository = makeEmptyRepository();
  try {
    const request = async ({ pathname }) => {
      if (pathname === '/api/server/version') return { status: 200, body: '9.9.0' };
      if (pathname === '/api/issues/search') return { status: 200, body: JSON.stringify({ paging: { total: 3 }, issues: [{ key: '1', rule: 'x', component: 'p:a.js', message: 'one' }, { key: '2', rule: 'x', component: 'p:b.js', message: 'two' }] }) };
      if (pathname === '/api/project_analyses/search') return { status: 200, body: JSON.stringify({ analyses: [] }) };
      throw new Error('unexpected');
    };
    const partial = await importSonar(repository, { url: 'https://sonar.example.invalid', project: 'p', maxResults: 2, request });
    assert.equal(partial.status, 'PARTIAL');
    assert.equal(partial.engine.measurementStatus, 'PARTIAL');
    assert.ok(partial.diagnostics.some((item) => item.code === 'RESULT_LIMIT_REACHED'));
    await assert.rejects(() => importSonar(repository, { url: 'https://sonar.example.invalid', project: 'p', request: async ({ pathname }) => pathname === '/api/server/version' ? { status: 200, body: '10.0' } : { status: 403, body: '{"errors":[{"msg":"Insufficient permissions"}]}' } }), /HTTP 403/);
  } finally {
    cleanup(repository);
  }
});
