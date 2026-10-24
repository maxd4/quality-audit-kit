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

test('init creates an explicit config and reports detected structure', () => {
  const repository = makeRepository();
  try {
    const result = runCli(repository, ['init']);
    assert.equal(result.status, 0);
    const config = JSON.parse(fs.readFileSync(path.join(repository, 'quality-audit-kit.config.json'), 'utf8'));
    assert.equal(config.version, '0.1-draft');
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
