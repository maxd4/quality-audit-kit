const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NPM = process.platform === 'win32'
  ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : 'npm';

function runNpm(args, cwd) {
  const started = performance.now();
  const command = process.platform === 'win32' ? process.execPath : NPM;
  const commandArgs = process.platform === 'win32' ? [NPM, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  if (result.error) throw new Error(`npm ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit ${result.status}.\n${String(result.stdout || '').trim()}\n${String(result.stderr || '').trim()}`.trim());
  }
  return { durationMs, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-package-'));
  const consumer = path.join(temporaryRoot, 'consumer');
  fs.mkdirSync(consumer);
  try {
    const packed = runNpm(['pack', '--ignore-scripts', '--pack-destination', temporaryRoot], ROOT);
    const tarballs = fs.readdirSync(temporaryRoot).filter((name) => name.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, 'npm pack must create exactly one tarball');
    const tarball = path.join(temporaryRoot, tarballs[0]);
    const packedBytes = fs.statSync(tarball).size;
    runNpm(['init', '--yes', '--ignore-scripts'], consumer);
    const installed = runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer);
    const executable = path.join(consumer, 'node_modules', 'quality-audit-kit', 'bin', 'quality-audit-kit.js');
    assert.equal(fs.existsSync(executable), true, 'installed package must contain its executable');
    const help = spawnSync(process.execPath, [executable, '--help'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
    assert.equal(help.status, 0, `installed executable --help failed: ${help.stderr}`);
    assert.match(help.stdout, /quality-audit-kit init/);
    const uninstalled = runNpm(['uninstall', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', 'quality-audit-kit'], consumer);
    assert.equal(fs.existsSync(path.dirname(executable)), false, 'npm uninstall must remove the installed package');
    const result = {
      status: 'PASS',
      package: 'quality-audit-kit',
      packageTarballBytes: packedBytes,
      packMs: packed.durationMs,
      installMs: installed.durationMs,
      uninstallMs: uninstalled.durationMs,
      network: 'offline',
      publication: 'NOT_RUN',
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main();
