const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

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
    assert.equal(preview.status, 0, preview.stderr);
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
      thresholds: { metrics: [{ name: 'duplication_ratio', unit: 'percent', direction: 'LOWER_IS_BETTER', language: 'javascript', workspace: 'packages/app', fileCategory: 'runtime', value: 10 }] },
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
