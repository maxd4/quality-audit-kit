const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'quality-audit-kit.js');
const NPM_CLI = process.platform === 'win32'
  ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : 'npm';

const COMMAND_EXPECTATIONS = Object.freeze({
  'init-preview': { expectedExitCodes: [0], essential: false },
  scan: { expectedExitCodes: [0], essential: true },
  'scan-repeat': { expectedExitCodes: [0], essential: true },
  report: { expectedExitCodes: [0], essential: true },
  plan: { expectedExitCodes: [0], essential: true },
  thresholds: { expectedExitCodes: [0], essential: true },
  'fix-preview': { expectedExitCodes: [0, 2], essential: false },
  verify: { expectedExitCodes: [0, 2], essential: false },
});

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

function runCommand(name, args, expectation = COMMAND_EXPECTATIONS[name] || { expectedExitCodes: [0], essential: false }) {
  const before = process.resourceUsage();
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const after = process.resourceUsage();
  const exitCode = result.status;
  const expected = expectation.expectedExitCodes.includes(exitCode);
  return {
    name,
    args,
    exitCode,
    expectedExitCodes: expectation.expectedExitCodes,
    essential: expectation.essential,
    outcome: expected ? (exitCode === 2 ? 'EXPECTED_BLOCKED' : 'PASS') : 'FAILURE',
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

function pathKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function observedFilePaths(target) {
  const result = spawnSync('git', ['-C', target, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    return { paths: [], diagnostics: [{ code: 'FILE_LIST_UNAVAILABLE', message: 'Could not enumerate tracked and non-ignored untracked files with git ls-files.' }] };
  }
  return { paths: String(result.stdout || '').split('\0').filter(Boolean), diagnostics: [] };
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotParentBoundary(root, candidate, relativePath) {
  let current = path.dirname(candidate);
  while (current !== root && isInside(root, current)) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return { code: 'FILE_PARENT_SNAPSHOT_FAILED', path: relativePath, message: error.message };
    }
    if (stat.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(current);
      } catch (error) {
        return { code: 'SYMLINK_PARENT_RESOLUTION_FAILED', path: relativePath, message: error.message };
      }
      if (!isInside(root, real)) {
        return { code: 'SYMLINK_PARENT_OUTSIDE_REPOSITORY', path: relativePath, message: 'A symbolic-link parent resolves outside the repository; its child was not read.' };
      }
      return { code: 'SYMLINK_PARENT_NOT_ALLOWED', path: relativePath, message: 'A symbolic-link parent is not followed during content snapshots, even when its destination is inside the repository.' };
    }
    current = path.dirname(current);
  }
  return null;
}

function snapshotFiles(target) {
  const root = fs.realpathSync(target);
  const listed = observedFilePaths(target);
  const files = {};
  const diagnostics = [...listed.diagnostics];
  for (const relativePath of listed.paths) {
    const candidate = path.resolve(root, relativePath);
    if (!isInside(root, candidate)) {
      diagnostics.push({ code: 'FILE_PATH_OUTSIDE_REPOSITORY', path: relativePath, message: 'The observed file path escaped the lexical repository root.' });
      continue;
    }
    const parentDiagnostic = snapshotParentBoundary(root, candidate, relativePath);
    if (parentDiagnostic) {
      diagnostics.push(parentDiagnostic);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(candidate); } catch (error) {
      diagnostics.push({ code: 'FILE_SNAPSHOT_FAILED', path: relativePath, message: error.message });
      continue;
    }
    if (stat.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync(candidate); } catch (error) {
        diagnostics.push({ code: 'SYMLINK_RESOLUTION_FAILED', path: relativePath, message: error.message });
        continue;
      }
      if (!isInside(root, real)) {
        diagnostics.push({ code: 'SYMLINK_OUTSIDE_REPOSITORY', path: relativePath, message: 'A symbolic link outside the repository was not followed.' });
        continue;
      }
      const linkTarget = fs.readlinkSync(candidate);
      files[relativePath] = { type: 'SYMLINK', size: Buffer.byteLength(linkTarget, 'utf8'), sha256: hashBytes(linkTarget) };
      continue;
    }
    if (!stat.isFile()) {
      diagnostics.push({ code: 'FILE_TYPE_UNSUPPORTED', path: relativePath, message: 'Only regular files and in-repository symbolic links are included in the content snapshot.' });
      continue;
    }
    try {
      const content = fs.readFileSync(candidate);
      files[relativePath] = { type: 'FILE', size: content.byteLength, sha256: hashBytes(content) };
    } catch (error) {
      diagnostics.push({ code: 'FILE_SNAPSHOT_FAILED', path: relativePath, message: error.message });
    }
  }
  return {
    status: diagnostics.length ? 'NOT_VERIFIED' : 'VERIFIED',
    files,
    diagnostics,
    observedFileCount: Object.keys(files).length,
    ignoredFilesNotObserved: true,
    symlinkPolicy: 'Final in-repository links are represented as links. Final links resolving outside the repository and all symbolic-link parents are excluded and reported; parent links are never followed during content reads.',
  };
}

function compareSnapshots(before, after) {
  if (before.status !== 'VERIFIED' || after.status !== 'VERIFIED') return { status: 'NOT_VERIFIED', preserved: null, changedFiles: [], reason: 'One or both content snapshots were incomplete.' };
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  const changedFiles = paths.filter((filePath) => JSON.stringify(before.files[filePath] || null) !== JSON.stringify(after.files[filePath] || null));
  return { status: changedFiles.length ? 'MUTATED' : 'VERIFIED', preserved: changedFiles.length === 0, changedFiles, reason: changedFiles.length ? 'Observed file size, type or SHA-256 changed.' : 'All observed file snapshots match.' };
}

function readJsonArtifact(filePath, label) {
  if (!fs.existsSync(filePath)) return { ok: false, status: 'MISSING', diagnostic: { code: 'ARTIFACT_MISSING', stage: label, path: filePath, message: `${label} did not produce an artifact.` } };
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('artifact root is not a JSON object');
    return { ok: true, status: 'VALID_JSON', value };
  } catch (error) {
    return { ok: false, status: 'INVALID_JSON', diagnostic: { code: 'ARTIFACT_INVALID_JSON', stage: label, path: filePath, message: error.message } };
  }
}

function validateRunArtifact(filePath, label) {
  const artifact = readJsonArtifact(filePath, label);
  if (!artifact.ok) return artifact;
  const run = artifact.value;
  const diagnostics = [];
  if (run.schemaVersion !== '0.1-draft' || typeof run.runId !== 'string' || !run.runId) diagnostics.push({ code: 'RUN_CONTRACT_INVALID', stage: label, message: 'Run artifact lacks the expected schemaVersion or runId.' });
  if (!Array.isArray(run.engines) || !Array.isArray(run.findings)) diagnostics.push({ code: 'RUN_SHAPE_INVALID', stage: label, message: 'Run artifact must contain engines and findings arrays.' });
  const sarif = Array.isArray(run.engines) ? run.engines.find((engine) => engine.name === 'sarif') : null;
  const findings = Array.isArray(run.findings) ? run.findings.filter((finding) => finding.engine === 'sarif') : [];
  if (!sarif) diagnostics.push({ code: 'SARIF_ENGINE_MISSING', stage: label, message: 'The run did not record the canonical SARIF engine.' });
  else if (sarif.measurementStatus !== 'MEASURED') diagnostics.push({ code: 'SARIF_MEASUREMENT_NOT_MEASURED', stage: label, status: sarif.measurementStatus, message: 'The SARIF engine was not measured completely.' });
  if (!findings.length) diagnostics.push({ code: 'SARIF_FINDINGS_MISSING', stage: label, message: 'The run did not import any SARIF findings for the positive harness.' });
  return { ok: diagnostics.length === 0, status: diagnostics.length ? 'INVALID_CONTRACT' : 'VALID_RUN', value: run, diagnostics };
}

function validateReportArtifact(filePath, run) {
  const artifact = readJsonArtifact(filePath, 'report');
  if (!artifact.ok) return artifact;
  const report = artifact.value;
  const diagnostics = [];
  if (report.reportType !== 'QUALITY_AUDIT_RUN_REPORT' || !Array.isArray(report.measurements) || !report.findings || typeof report.findings !== 'object') diagnostics.push({ code: 'REPORT_CONTRACT_INVALID', stage: 'report', message: 'Report artifact lacks the expected structured report fields.' });
  if (report.runId !== run.runId) diagnostics.push({ code: 'REPORT_RUN_ID_MISMATCH', stage: 'report', expected: run.runId, actual: report.runId, message: 'Report is not attributable to the scan run.' });
  return { ok: diagnostics.length === 0, status: diagnostics.length ? 'INVALID_CONTRACT' : 'VALID_REPORT', value: report, diagnostics };
}

function validatePlanArtifact(filePath, run) {
  const artifact = readJsonArtifact(filePath, 'plan');
  if (!artifact.ok) return artifact;
  const plan = artifact.value;
  const diagnostics = [];
  if (plan.planType !== 'QUALITY_CORRECTION_PLAN' || !Array.isArray(plan.lots) || !Array.isArray(plan.prompts)) diagnostics.push({ code: 'PLAN_CONTRACT_INVALID', stage: 'plan', message: 'Plan artifact lacks the expected correction-plan fields.' });
  if (plan.runId !== run.runId) diagnostics.push({ code: 'PLAN_RUN_ID_MISMATCH', stage: 'plan', expected: run.runId, actual: plan.runId, message: 'Plan is not attributable to the scan run.' });
  return { ok: diagnostics.length === 0, status: diagnostics.length ? 'INVALID_CONTRACT' : 'VALID_PLAN', value: plan, diagnostics };
}

function validateThresholdArtifact(filePath, run) {
  const artifact = readJsonArtifact(filePath, 'thresholds');
  if (!artifact.ok) return artifact;
  const thresholds = artifact.value;
  const diagnostics = [];
  if (thresholds.kind !== 'QUALITY_THRESHOLDS_RECOMMENDATION' || !Array.isArray(thresholds.proposals) || !thresholds.measurement) diagnostics.push({ code: 'THRESHOLDS_CONTRACT_INVALID', stage: 'thresholds', message: 'Threshold artifact lacks the expected recommendation fields.' });
  if (thresholds.runId !== run.runId) diagnostics.push({ code: 'THRESHOLDS_RUN_ID_MISMATCH', stage: 'thresholds', expected: run.runId, actual: thresholds.runId, message: 'Threshold recommendations are not attributable to the scan run.' });
  return { ok: diagnostics.length === 0, status: diagnostics.length ? 'INVALID_CONTRACT' : 'VALID_THRESHOLDS', value: thresholds, diagnostics };
}

function diagnosticsForCommands(commands) {
  return commands.flatMap((command) => command.outcome === 'FAILURE' ? [{ code: command.essential ? 'ESSENTIAL_COMMAND_FAILED' : 'COMMAND_FAILED', stage: command.name, exitCode: command.exitCode, message: `${command.name} returned ${command.exitCode}; expected ${command.expectedExitCodes.join(' or ')}.` }] : []);
}

function evaluateTarget(target, sarif, label) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `qak-evaluation-${label}-`));
  const paths = Object.fromEntries(['run', 'runRepeat', 'report', 'plan', 'planMarkdown', 'thresholds', 'proposal', 'fix', 'verify'].map((name) => [name, path.join(temporaryRoot, `${name === 'runRepeat' ? 'run-repeat' : name === 'planMarkdown' ? 'plan' : name === 'proposal' ? 'thresholds-proposal' : name === 'fix' ? 'fix-result' : name === 'verify' ? 'verification' : name}.json`)]));
  paths.planMarkdown = path.join(temporaryRoot, 'plan.md');
  const beforeStatus = gitStatus(target);
  const beforeSnapshot = snapshotFiles(target);
  const commands = [];
  const diagnostics = [];
  let afterStatus = 'NOT_VERIFIED';
  let afterSnapshot = { status: 'NOT_VERIFIED', files: {}, diagnostics: [{ code: 'SNAPSHOT_NOT_RUN', message: 'The after snapshot was not produced.' }], symlinkPolicy: beforeSnapshot.symlinkPolicy };
  let scanArtifact = null;
  let repeatArtifact = null;
  try {
    commands.push(runCommand('init-preview', ['init', target, '--preview', '--templates', 'none']));
    commands.push(runCommand('scan', ['scan', target, '--sarif-report', sarif, '--output', paths.run]));
    commands.push(runCommand('scan-repeat', ['scan', target, '--sarif-report', sarif, '--output', paths.runRepeat]));
    commands.push(runCommand('report', ['report', paths.run, '--format', 'json', '--output', paths.report]));
    commands.push(runCommand('plan', ['plan', paths.run, '--output', paths.plan, '--markdown', paths.planMarkdown]));
    commands.push(runCommand('thresholds', ['thresholds', 'recommend', paths.run, '--repository', target, '--output', paths.thresholds, '--export', paths.proposal]));
    commands.push(runCommand('fix-preview', ['fix', '--next', paths.plan, '--repository', target, '--output', paths.fix]));
    commands.push(runCommand('verify', ['verify', paths.fix, '--output', paths.verify]));
    diagnostics.push(...diagnosticsForCommands(commands));
    scanArtifact = validateRunArtifact(paths.run, 'scan');
    repeatArtifact = validateRunArtifact(paths.runRepeat, 'scan-repeat');
    for (const artifact of [scanArtifact, repeatArtifact]) if (!artifact.ok) diagnostics.push(...(artifact.diagnostics || [artifact.diagnostic]));
    if (scanArtifact.ok) {
      for (const artifact of [validateReportArtifact(paths.report, scanArtifact.value), validatePlanArtifact(paths.plan, scanArtifact.value), validateThresholdArtifact(paths.thresholds, scanArtifact.value)]) {
        if (!artifact.ok) diagnostics.push(...(artifact.diagnostics || [artifact.diagnostic]));
      }
    }
    const firstIds = scanArtifact.ok ? scanArtifact.value.findings.filter((finding) => finding.engine === 'sarif').map((finding) => finding.id).sort() : null;
    const repeatedIds = repeatArtifact.ok ? repeatArtifact.value.findings.filter((finding) => finding.engine === 'sarif').map((finding) => finding.id).sort() : null;
    if (firstIds === null || repeatedIds === null || JSON.stringify(firstIds) !== JSON.stringify(repeatedIds)) diagnostics.push({ code: 'FINDING_IDS_NOT_STABLE', stage: 'scan-repeat', message: 'Repeated scans did not produce identical SARIF finding IDs.' });
    afterStatus = gitStatus(target);
    afterSnapshot = snapshotFiles(target);
  } catch (error) {
    diagnostics.push({ code: 'HARNESS_EXCEPTION', stage: 'evaluate', message: error.message });
    afterStatus = gitStatus(target);
    afterSnapshot = snapshotFiles(target);
  }
  const gitStatusKnown = beforeStatus !== 'NOT_A_GIT_REPOSITORY' && afterStatus !== 'NOT_A_GIT_REPOSITORY';
  const gitStatusPreserved = gitStatusKnown ? beforeStatus === afterStatus : null;
  if (gitStatusPreserved === false) diagnostics.push({ code: 'GIT_STATUS_CHANGED', stage: 'non-mutation', message: 'The target Git status changed during evaluation.' });
  const contentComparison = compareSnapshots(beforeSnapshot, afterSnapshot);
  if (contentComparison.status === 'MUTATED') diagnostics.push({ code: 'CONTENT_MUTATED', stage: 'non-mutation', changedFiles: contentComparison.changedFiles, message: contentComparison.reason });
  if (contentComparison.status === 'NOT_VERIFIED') diagnostics.push({ code: 'CONTENT_NOT_VERIFIED', stage: 'non-mutation', message: contentComparison.reason });
  diagnostics.push(...beforeSnapshot.diagnostics.map((item) => ({ ...item, stage: 'snapshot-before' })));
  diagnostics.push(...afterSnapshot.diagnostics.map((item) => ({ ...item, stage: 'snapshot-after' })));
  const status = diagnostics.length ? (contentComparison.status === 'NOT_VERIFIED' ? 'INCOMPLETE' : 'FAILURE') : 'PASS_WITH_LIMITS';
  const firstFindings = scanArtifact?.ok ? scanArtifact.value.findings.filter((finding) => finding.engine === 'sarif').map((finding) => finding.id).sort() : null;
  const repeatedFindings = repeatArtifact?.ok ? repeatArtifact.value.findings.filter((finding) => finding.engine === 'sarif').map((finding) => finding.id).sort() : null;
  const result = {
    status,
    label,
    target,
    gitHead: gitHead(target),
    gitStatusPreserved,
    worktreeStatusPreserved: gitStatusPreserved,
    contentPreserved: contentComparison.preserved,
    contentSnapshot: { status: contentComparison.status, before: beforeSnapshot.files, after: afterSnapshot.files, changedFiles: contentComparison.changedFiles, ignoredFilesNotObserved: true, externalEffects: 'NOT_OBSERVABLE', symlinkPolicy: beforeSnapshot.symlinkPolicy },
    commands,
    artifacts: {
      scan: { status: scanArtifact?.status || 'NOT_READ', runId: scanArtifact?.value?.runId || null, findingCount: firstFindings?.length ?? null },
      scanRepeat: { status: repeatArtifact?.status || 'NOT_READ', runId: repeatArtifact?.value?.runId || null, findingCount: repeatedFindings?.length ?? null },
      report: { path: paths.report, status: fs.existsSync(paths.report) ? 'PRESENT' : 'MISSING' },
      plan: { path: paths.plan, status: fs.existsSync(paths.plan) ? 'PRESENT' : 'MISSING' },
      thresholds: { path: paths.thresholds, status: fs.existsSync(paths.thresholds) ? 'PRESENT' : 'MISSING' },
    },
    findings: { firstCount: firstFindings?.length ?? null, repeatCount: repeatedFindings?.length ?? null, stableIds: firstFindings !== null && repeatedFindings !== null && JSON.stringify(firstFindings) === JSON.stringify(repeatedFindings), classificationGroundTruth: 'NOT_RUN_BY_THIS_READ_ONLY_WORKFLOW' },
    diagnostics,
    humanApprovalPoints: 0,
    ratchetMutation: 'NOT_RUN_BY_THIS_READ_ONLY_WORKFLOW',
    artifactsBytes: fileBytes(temporaryRoot),
    resourceScope: 'runner process CPU/RSS plus output bytes; child peak RSS is not claimed',
    platform: { os: process.platform, arch: process.arch, node: process.version },
  };
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  return result;
}

function duplicateTargetResult(target, label, duplicateOf) {
  return { status: 'FAILURE', label, target, gitHead: gitHead(target), gitStatusPreserved: null, worktreeStatusPreserved: null, contentPreserved: null, contentSnapshot: { status: 'NOT_VERIFIED', before: {}, after: {}, changedFiles: [], ignoredFilesNotObserved: true, externalEffects: 'NOT_OBSERVABLE' }, commands: [], artifacts: {}, findings: { firstCount: null, repeatCount: null, stableIds: false, classificationGroundTruth: 'NOT_RUN_BY_THIS_READ_ONLY_WORKFLOW' }, diagnostics: [{ code: 'DUPLICATE_TARGET', stage: 'target-selection', target, duplicateOf, message: 'This path resolves to a repository already selected; no independent measurement was presented.' }], humanApprovalPoints: 0, ratchetMutation: 'NOT_RUN_BY_THIS_READ_ONLY_WORKFLOW', artifactsBytes: 0, resourceScope: 'No measurement executed for the duplicate target.', platform: { os: process.platform, arch: process.arch, node: process.version } };
}

function main(argv = process.argv.slice(2)) {
  const targets = optionValues(argv, '--target');
  const sarif = optionValues(argv, '--sarif')[0];
  const output = optionValues(argv, '--output')[0];
  if (targets.length < 2) throw new Error('measure-workflows requires at least two --target repository paths.');
  if (!sarif) throw new Error('measure-workflows requires --sarif report.sarif.');
  const seen = new Map();
  const results = targets.map((target, index) => {
    const absoluteTarget = path.resolve(target);
    if (!fs.statSync(absoluteTarget).isDirectory()) throw new Error(`Evaluation target is not a directory: ${target}`);
    const realTarget = fs.realpathSync(absoluteTarget);
    const label = `repo-${index + 1}`;
    const key = pathKey(realTarget);
    if (seen.has(key)) return duplicateTargetResult(realTarget, label, seen.get(key));
    seen.set(key, label);
    return evaluateTarget(realTarget, path.resolve(sarif), label);
  });
  const status = results.every((result) => result.status === 'PASS_WITH_LIMITS') ? 'PASS_WITH_LIMITS' : results.some((result) => result.status === 'FAILURE') ? 'FAILURE' : 'INCOMPLETE';
  const payload = { status, measuredAt: new Date().toISOString(), packageRoot: ROOT, targetCount: results.length, platform: { os: process.platform, arch: process.arch, node: process.version }, npm: npmVersion(), humanApprovalPoints: 0, classificationGroundTruth: 'NOT_RUN', ratchetMutation: 'NOT_RUN', results };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (output) fs.writeFileSync(path.resolve(output), content, 'utf8');
  process.stdout.write(content);
  process.exitCode = status === 'PASS_WITH_LIMITS' ? 0 : 2;
  return payload;
}

if (require.main === module) main();

module.exports = { COMMAND_EXPECTATIONS, compareSnapshots, evaluateTarget, main, pathKey, snapshotFiles, validatePlanArtifact, validateReportArtifact, validateRunArtifact, validateThresholdArtifact };
