const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { discover, relativePath, resolveLocalBinary } = require('./discovery');
const { loadOrRunScanner } = require('./scanners');
const { sanitizeForExport } = require('./report');
const { createAgentAdapter } = require('./agents');

const FIX_STATUSES = new Set(['READY', 'RESOLVED', 'FAILED', 'BLOCKED', 'UNVERIFIED', 'NEEDS_TRIAGE', 'NEEDS_REVIEW', 'BLOCKED_BY_MEASUREMENT']);
const PROTECTED_NAMES = new Set([
  'quality-audit-kit.config.json',
  'quality-audit-kit.baseline.json',
  'quality-audit-kit.decisions.json',
  'quality-audit-kit.plan.json',
  'quality-audit-kit.plan.md',
  'AGENTS.md',
  'PROJECT_HANDOFF.md',
  'COMMIT_REVIEW.md',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeRelative(root, value) {
  const candidate = path.resolve(root, String(value || ''));
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function isProtectedPath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  return normalized === '.git' || normalized.startsWith('.git/') || PROTECTED_NAMES.has(path.posix.basename(normalized));
}

function parseStatus(output) {
  const entries = new Map();
  for (const raw of String(output || '').split('\0').filter(Boolean)) {
    const code = raw.slice(0, 2);
    const value = raw.slice(3);
    const paths = /^[RC]/.test(code) && value.includes(' -> ')
      ? value.split(' -> ')
      : [value];
    for (const item of paths) entries.set(item.replace(/\\/g, '/'), code);
  }
  return entries;
}

function fileDigest(root, relative) {
  const filePath = path.join(root, relative.split('/').join(path.sep));
  try {
    return fs.statSync(filePath).isFile() ? sha256(fs.readFileSync(filePath)) : null;
  } catch {
    return null;
  }
}

function gitSnapshot(root) {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (status.error || status.status !== 0 || head.error || head.status !== 0) return { available: false, entries: new Map(), digests: new Map(), head: null };
  const entries = parseStatus(status.stdout);
  const digests = new Map([...entries.keys()].map((relative) => [relative, fileDigest(root, relative)]));
  return { available: true, entries, digests, head: String(head.stdout || '').trim() };
}

function compareSnapshots(before, after, allowedFiles) {
  const allowed = new Set(allowedFiles);
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const foreignChanges = [];
  const deletions = [];
  const allowedChanges = [];
  for (const relative of paths) {
    const beforeCode = before.entries.get(relative) || null;
    const afterCode = after.entries.get(relative) || null;
    const beforeDigest = before.digests.get(relative) || null;
    const afterDigest = after.digests.get(relative) || null;
    const changed = beforeCode !== afterCode || beforeDigest !== afterDigest;
    if (!changed) continue;
    if (!afterDigest && afterCode && /D/.test(afterCode)) deletions.push(relative);
    if (allowed.has(relative)) allowedChanges.push(relative);
    else foreignChanges.push({ path: relative, before: beforeCode, after: afterCode });
  }
  return {
    clean: foreignChanges.length === 0 && deletions.length === 0 && before.head === after.head,
    allowedChanges: [...new Set(allowedChanges)].sort(),
    foreignChanges,
    deletions,
    headChanged: before.head !== after.head,
  };
}

function validateLot(root, lot) {
  if (!lot || lot.status !== 'READY') return { status: 'BLOCKED', reason: `Lot is not executable: ${lot?.status || 'UNKNOWN'}.` };
  if (!Array.isArray(lot.files) || !lot.files.length || lot.files.some((file) => !normalizeRelative(root, file))) return { status: 'BLOCKED', reason: 'Lot does not provide a bounded, repository-relative file allowlist.' };
  const allowedFiles = [...new Set(lot.files.map((file) => normalizeRelative(root, file)))].sort();
  if (allowedFiles.some((file) => isProtectedPath(file))) return { status: 'BLOCKED', reason: 'Lot includes a protected policy, governance or Quality Audit Kit artifact.' };
  return { status: 'READY', allowedFiles };
}

function boundedPrompt(lot, allowedFiles) {
  return [
    lot.prompt || '',
    '',
    '## Execution authorization and hard boundaries',
    '',
    'This prompt is executed only because the caller supplied explicit agent authorization. Modify only the following repository-relative files:',
    ...allowedFiles.map((file) => `- ${file}`),
    '',
    'Do not modify any other file. Do not create or delete files. Do not commit, amend, reset, checkout, push, change a baseline, change decisions, change policy, install dependencies, publish data or contact a service. Stop and report BLOCKED if the correction requires anything outside the allowlist or if a pre-existing change is present in an approved file.',
    '',
    'Return a concise redacted summary of files changed, checks run and remaining uncertainty. Do not include secrets, tokens, absolute paths or source excerpts.',
  ].join('\n');
}

function sourceRevisionForExecution(discovery) {
  if (discovery.git?.worktree === 'CLEAN' && discovery.git.head) return { status: 'VERIFIED', sha: discovery.git.head, basis: 'Scanner executed against a clean worktree represented by HEAD.' };
  return { status: 'UNVERIFIED', sha: null, basis: 'Correction verification ran against a live worktree with uncommitted changes.' };
}

async function reanalyzeLot(root, lot) {
  const engines = [...new Set(lot.findings.map((finding) => finding.engine).filter(Boolean))];
  const unsupported = engines.filter((engine) => !['knip', 'jscpd'].includes(engine));
  if (unsupported.length) return { status: 'BLOCKED', reason: `No local reanalysis adapter exists for: ${unsupported.join(', ')}.`, engines: [] };
  const discovery = discover(root);
  const results = [];
  const findings = [];
  for (const scanner of engines) {
    const result = await loadOrRunScanner({
      root,
      scanner,
      executeScanner: true,
      binary: resolveLocalBinary(root, scanner),
      executionSourceRevision: sourceRevisionForExecution(discovery),
    });
    results.push({ name: scanner, measurementStatus: result.status, sourceRevision: result.sourceRevision, diagnostic: result.diagnostic || null });
    findings.push(...(result.findings || []));
  }
  const targetIds = new Set(lot.findings.map((finding) => finding.id));
  const targetSignatures = new Set(lot.findings.map((finding) => `${finding.engine}|${finding.ruleId}|${finding.path}`));
  const remaining = findings.filter((finding) => targetIds.has(finding.id) || targetSignatures.has(`${finding.engine}|${finding.ruleId}|${finding.path}`));
  const complete = results.length > 0 && results.every((engine) => engine.measurementStatus === 'MEASURED');
  const verified = complete && results.every((engine) => engine.sourceRevision?.status === 'VERIFIED');
  return {
    status: complete ? (remaining.length ? 'FINDINGS_REMAIN' : verified ? 'MEASURED_VERIFIED' : 'MEASURED_UNVERIFIED') : 'BLOCKED',
    engines: results,
    targetedFindingIds: [...targetIds].sort(),
    remainingFindings: remaining,
    sourceRevisionStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
  };
}

function validationNames(root) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return Object.keys(packageJson.scripts || {}).filter((name) => /^(test|check|lint|typecheck|type-check|validate|verify)([:._-]|$)/i.test(name)).sort();
  } catch {
    return [];
  }
}

function validationCommand(root, name) {
  let packageManager = 'npm';
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (fs.existsSync(path.join(root, 'yarn.lock'))) packageManager = 'yarn';
    else if (packageJson.packageManager?.startsWith('pnpm@')) packageManager = 'pnpm';
  } catch { /* no package metadata means validations are not runnable */ }
  return packageManager === 'yarn' ? ['run', name] : ['run', name];
}

function runValidations(root) {
  const names = validationNames(root);
  if (!names.length) return { status: 'NOT_RUN', validations: [], reason: 'No safe validation script was detected.' };
  const validations = [];
  for (const name of names) {
    const manager = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    const executable = process.platform === 'win32' && manager === 'npm' ? 'npm.cmd' : manager;
    const result = spawnSync(executable, validationCommand(root, name), { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    validations.push({ name, status: result.status === 0 ? 'PASS' : result.error?.code === 'ETIMEDOUT' ? 'BLOCKED' : 'FAIL', exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '' });
  }
  return { status: validations.every((item) => item.status === 'PASS') ? 'PASS' : validations.some((item) => item.status === 'BLOCKED') ? 'BLOCKED' : 'FAIL', validations };
}

function classifyExecution(execution, scope, reanalysis, validations) {
  if (execution.status !== 'COMPLETED') return 'FAILED';
  if (!scope.clean || scope.headChanged) return 'FAILED';
  if (!scope.allowedChanges.length) return 'UNVERIFIED';
  if (reanalysis.status === 'BLOCKED') return 'BLOCKED';
  if (reanalysis.status === 'FINDINGS_REMAIN') return 'FAILED';
  if (reanalysis.status !== 'MEASURED_VERIFIED') return 'UNVERIFIED';
  if (validations.status === 'FAIL') return 'FAILED';
  if (validations.status !== 'PASS') return 'UNVERIFIED';
  return 'RESOLVED';
}

function redactResult(result) {
  return sanitizeForExport(result);
}

function previewFix(plan, next, validation) {
  return redactResult({
    schemaVersion: '0.1-draft',
    fixVersion: '0.1-draft',
    kind: 'QUALITY_FIX_RESULT',
    mode: 'PREVIEW',
    status: next.status,
    planId: plan.planId,
    runId: plan.runId,
    reason: next.reason,
    lot: next.lot || null,
    prompt: next.lot ? (plan.prompts.find((prompt) => prompt.lotId === next.lot.id)?.content || next.lot.prompt) : null,
    authorization: { required: true, received: false, execution: 'NOT_EXECUTED' },
    validationPolicy: validation,
    noImplicitMutation: true,
  });
}

async function executeFix({ plan, next, root, agentName = 'codex', agentOptions = {}, approve = false, execute = approve, adapter, reanalyze = reanalyzeLot, validate = runValidations }) {
  const lotCheck = validateLot(root, next.lot);
  if (next.status !== 'READY' || lotCheck.status !== 'READY') return previewFix(plan, next.status === 'READY' ? { ...next, status: lotCheck.status, reason: lotCheck.reason } : next, 'NOT_RUN');
  if (!execute) return previewFix(plan, next, 'NOT_RUN');
  if (!approve) return redactResult({ ...previewFix(plan, next, 'NOT_RUN'), mode: 'BLOCKED', status: 'BLOCKED', reason: 'Explicit --approve is required before an agent may execute.' });
  const allowedFiles = lotCheck.allowedFiles;
  const before = gitSnapshot(root);
  if (!before.available) return redactResult({ ...previewFix(plan, next, 'NOT_RUN'), mode: 'BLOCKED', status: 'BLOCKED', reason: 'Git state is unavailable; the workflow cannot prove preservation of pre-existing changes.' });
  const dirtyApproved = allowedFiles.filter((file) => before.entries.has(file));
  if (dirtyApproved.length) return redactResult({ ...previewFix(plan, next, 'NOT_RUN'), mode: 'BLOCKED', status: 'BLOCKED', reason: 'Approved files already contain pre-existing changes; they are not overwritten.', dirtyApprovedFiles: dirtyApproved });
  const selectedAdapter = adapter || createAgentAdapter(agentName, agentOptions);
  const prompt = boundedPrompt(next.lot, allowedFiles);
  const execution = await selectedAdapter.execute({ root, prompt, lot: next.lot, allowedFiles });
  const after = gitSnapshot(root);
  const executionScope = compareSnapshots(before, after, allowedFiles);
  const reanalysis = executionScope.clean && !executionScope.headChanged ? await reanalyze(root, next.lot) : { status: 'BLOCKED', reason: 'Scope or Git history changed; targeted reanalysis was not trusted.' };
  const validations = executionScope.clean && !executionScope.headChanged ? validate(root, next.lot) : { status: 'BLOCKED', validations: [], reason: 'Scope or Git history changed.' };
  const finalScope = compareSnapshots(before, gitSnapshot(root), allowedFiles);
  return redactResult({
    schemaVersion: '0.1-draft',
    fixVersion: '0.1-draft',
    kind: 'QUALITY_FIX_RESULT',
    mode: 'EXECUTION',
    status: classifyExecution(execution, finalScope, reanalysis, validations),
    planId: plan.planId,
    runId: plan.runId,
    lotId: next.lot.id,
    agent: { name: selectedAdapter.name, protocolVersion: selectedAdapter.protocolVersion, capabilities: selectedAdapter.capabilities },
    authorization: { required: true, received: true, execution: 'EXPLICIT_APPROVAL' },
    allowedFiles,
    execution: { status: execution.status, exitCode: execution.exitCode, command: execution.command || selectedAdapter.name, stdout: execution.stdout || '', stderr: execution.stderr || '', lastMessage: execution.lastMessage || '' },
    scopeAudit: finalScope,
    reanalysis,
    validations,
    noImplicitMutation: true,
    baselineMutation: 'NOT_REQUESTED',
    commit: 'NOT_REQUESTED',
    push: 'NOT_REQUESTED',
  });
}

function verifyFixResult(result) {
  if (!result || result.kind !== 'QUALITY_FIX_RESULT' || !result.schemaVersion || !FIX_STATUSES.has(result.status)) return { command: 'verify', status: 'BLOCKED', verified: false, reason: 'Invalid or unsupported fix result contract.' };
  const serialized = JSON.stringify(result);
  if (/(ghp_|github_pat_|sk-|Bearer\s+[A-Za-z0-9._-]{12,}|AKIA[A-Z0-9]{16})/i.test(serialized)) return { command: 'verify', status: 'FAILED', verified: false, reason: 'Fix result contains a token-like value and cannot be trusted.' };
  if (result.mode !== 'EXECUTION') return { command: 'verify', status: result.status, verified: false, reason: 'The artifact is a preview or blocked authorization record; no execution proof exists.' };
  if (result.scopeAudit?.foreignChanges?.length || result.scopeAudit?.headChanged || result.scopeAudit?.deletions?.length) return { command: 'verify', status: 'FAILED', verified: false, reason: 'The execution proof records an out-of-scope change, deletion or Git history mutation.' };
  if (result.status === 'RESOLVED' && result.reanalysis?.status === 'MEASURED_VERIFIED' && result.validations?.status === 'PASS') return { command: 'verify', status: 'RESOLVED', verified: true, reason: 'Targeted findings are absent from a verified reanalysis and validations passed.' };
  return { command: 'verify', status: result.status === 'RESOLVED' ? 'UNVERIFIED' : result.status, verified: false, reason: 'The recorded evidence is insufficient to prove a resolved correction.' };
}

module.exports = { FIX_STATUSES, boundedPrompt, classifyExecution, compareSnapshots, executeFix, gitSnapshot, previewFix, reanalyzeLot, runValidations, validateLot, verifyFixResult };
