const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'quality-audit-kit.js');
const NPM_CLI = process.platform === 'win32'
  ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : 'npm';

function optionValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function gitStatus(target) {
  const result = spawnSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout || '') : 'NOT_A_GIT_REPOSITORY';
}

function gitHead(target) {
  const result = spawnSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function runCommand(name, args) {
  const before = process.resourceUsage();
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const after = process.resourceUsage();
  return {
    name,
    args,
    exitCode: result.status,
    durationMs,
    stdoutBytes: Buffer.byteLength(String(result.stdout || ''), 'utf8'),
    stderrBytes: Buffer.byteLength(String(result.stderr || ''), 'utf8'),
    runnerCpuMs: Math.round((after.userCPUTime - before.userCPUTime + after.systemCPUTime - before.systemCPUTime) / 1000 * 100) / 100,
    runnerMaxRssKb: after.maxRSS,
    error: result.error ? String(result.error.message) : null,
  };
}

function npmVersion() {
  const command = process.platform === 'win32' ? process.execPath : NPM_CLI;
  const args = process.platform === 'win32' ? [NPM_CLI, '--version'] : ['--version'];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : 'NOT_AVAILABLE';
}

function fileBytes(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile()) total += fs.statSync(candidate).size;
    else if (entry.isDirectory()) total += fileBytes(candidate);
  }
  return total;
}

function readFindings(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const run = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return (run.findings || []).map((finding) => finding.id).sort();
}

function evaluateTarget(target, sarif, label) {
  const temporaryRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), `qak-evaluation-${label}-`));
  const runPath = path.join(temporaryRoot, 'run.json');
  const repeatRunPath = path.join(temporaryRoot, 'run-repeat.json');
  const reportPath = path.join(temporaryRoot, 'report.json');
  const planPath = path.join(temporaryRoot, 'plan.json');
  const planMarkdownPath = path.join(temporaryRoot, 'plan.md');
  const thresholdsPath = path.join(temporaryRoot, 'thresholds.json');
  const proposalPath = path.join(temporaryRoot, 'thresholds-proposal.json');
  const fixPath = path.join(temporaryRoot, 'fix-result.json');
  const verifyPath = path.join(temporaryRoot, 'verification.json');
  const beforeStatus = gitStatus(target);
  const commands = [];
  try {
    commands.push(runCommand('init-preview', ['init', target, '--preview', '--templates', 'none']));
    commands.push(runCommand('scan', ['scan', target, '--sarif-report', sarif, '--output', runPath]));
    commands.push(runCommand('scan-repeat', ['scan', target, '--sarif-report', sarif, '--output', repeatRunPath]));
    commands.push(runCommand('report', ['report', runPath, '--format', 'json', '--output', reportPath]));
    commands.push(runCommand('plan', ['plan', runPath, '--output', planPath, '--markdown', planMarkdownPath]));
    commands.push(runCommand('thresholds', ['thresholds', 'recommend', runPath, '--repository', target, '--output', thresholdsPath, '--export', proposalPath]));
    commands.push(runCommand('fix-preview', ['fix', '--next', planPath, '--repository', target, '--output', fixPath]));
    commands.push(runCommand('verify', ['verify', fixPath, '--output', verifyPath]));
    const afterStatus = gitStatus(target);
    const statuses = commands.map((command) => command.exitCode);
    assert.equal(afterStatus, beforeStatus, `${label}: Quality Audit Kit changed the target Git status`);
    assert.ok(statuses.every((status) => status === 0 || status === 2), `${label}: unexpected command exit status ${statuses.join(',')}`);
    const firstFindings = readFindings(runPath);
    const repeatedFindings = readFindings(repeatRunPath);
    return {
      label,
      target,
      gitHead: gitHead(target),
      worktreeStatusPreserved: true,
      commands,
      findings: {
        firstCount: firstFindings?.length ?? null,
        repeatCount: repeatedFindings?.length ?? null,
        stableIds: firstFindings !== null && JSON.stringify(firstFindings) === JSON.stringify(repeatedFindings),
        classificationGroundTruth: 'NOT_RUN_BY_THIS_READ_ONLY_WORKFLOW',
      },
      humanApprovalPoints: 0,
      ratchetMutation: 'NOT_RUN_BY_THIS_READ_ONLY_WORKFLOW',
      artifactsBytes: fileBytes(temporaryRoot),
      resourceScope: 'runner process CPU/RSS plus output bytes; child peak RSS is not claimed',
      platform: { os: process.platform, arch: process.arch, node: process.version },
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const targets = optionValues(process.argv.slice(2), '--target');
  const sarif = optionValues(process.argv.slice(2), '--sarif')[0];
  const output = optionValues(process.argv.slice(2), '--output')[0];
  if (targets.length < 2) throw new Error('measure-workflows requires at least two --target repository paths.');
  if (!sarif) throw new Error('measure-workflows requires --sarif report.sarif.');
  const results = targets.map((target, index) => {
    const absoluteTarget = path.resolve(target);
    if (!fs.statSync(absoluteTarget).isDirectory()) throw new Error(`Evaluation target is not a directory: ${target}`);
    return evaluateTarget(absoluteTarget, path.resolve(sarif), `repo-${index + 1}`);
  });
  const payload = {
    status: 'PASS_WITH_LIMITS',
    measuredAt: new Date().toISOString(),
    packageRoot: ROOT,
    targetCount: results.length,
    platform: { os: process.platform, arch: process.arch, node: process.version },
    npm: npmVersion(),
    humanApprovalPoints: 0,
    classificationGroundTruth: 'NOT_RUN',
    ratchetMutation: 'NOT_RUN',
    results,
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (output) fs.writeFileSync(path.resolve(output), content, 'utf8');
  process.stdout.write(content);
}

main();
