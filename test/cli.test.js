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
  } finally {
    cleanup(repository);
  }
});

test('scan imports Knip and jscpd reports into one stable contract', () => {
  const repository = makeRepository();
  try {
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
    assert.equal(runOne.findings.every((finding) => finding.provenance.kind === 'REPORT'), true);
    assert.deepEqual(runOne.discovery.workspaces.packages, ['packages/app']);
    assert.deepEqual(runOne.findings.map((finding) => finding.id), runTwo.findings.map((finding) => finding.id));
    assert.equal(runOne.findings.some((finding) => path.isAbsolute(finding.path)), false);

    const report = runCli(repository, ['report', 'run-one.json']);
    assert.equal(report.status, 0);
    assert.match(report.stdout, /Measurement status/);
    assert.match(report.stdout, /duplicate-code/);
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
    const result = runCli(repository, ['scan', '--run=knip,jscpd', '--output', 'executed.json']);
    const output = fs.readFileSync(path.join(repository, 'executed.json'), 'utf8');
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${output}`);
    const run = JSON.parse(output);
    assert.equal(run.engines.every((engine) => engine.measurementStatus === 'MEASURED'), true);
    assert.equal(run.findings.length, 1);
    assert.equal(run.findings[0].provenance.kind, 'EXECUTION');
  } finally {
    cleanup(repository);
  }
});
