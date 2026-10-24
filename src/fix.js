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

function physicalFileBoundary(root, relative) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { status: 'INVALID', reason: 'The repository root cannot be resolved physically.' };
  }
  let current = path.resolve(root);
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { status: 'INVALID', reason: 'Every allowlisted destination must already exist as a regular file.' };
    }
    if (stat.isSymbolicLink()) return { status: 'INVALID', reason: 'Symbolic links are not allowed in an executable correction allowlist.' };
  }
  let realPath;
  try {
    realPath = fs.realpathSync(current);
  } catch {
    return { status: 'INVALID', reason: 'The allowlisted destination cannot be resolved physically.' };
  }
  const relativeRealPath = path.relative(realRoot, realPath);
  if (!relativeRealPath || relativeRealPath === '..' || relativeRealPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRealPath)) return { status: 'INVALID', reason: 'The allowlisted destination is outside the repository boundary.' };
  try {
    if (!fs.lstatSync(realPath).isFile()) return { status: 'INVALID', reason: 'Only existing regular files may be modified by this workflow.' };
  } catch {
    return { status: 'INVALID', reason: 'The allowlisted destination is no longer available.' };
  }
  return { status: 'VALID', realPath };
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
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return sha256(`SYMBOLIC_LINK:${fs.readlinkSync(filePath)}`);
    return stat.isFile() ? sha256(fs.readFileSync(filePath)) : null;
  } catch {
    return null;
  }
}

function filesystemSnapshot(root) {
  const entries = new Map();
  const errors = [];
  function visit(directory, prefix = '') {
    let names;
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: prefix || '.', code: error.code || 'READ_FAILED' });
      return;
    }
    for (const entry of names) {
      if (!prefix && entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filePath = path.join(directory, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(filePath);
      } catch (error) {
        errors.push({ path: relative, code: error.code || 'STAT_FAILED' });
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          entries.set(relative, { type: 'SYMLINK', digest: sha256(`SYMBOLIC_LINK:${fs.readlinkSync(filePath)}`) });
        } catch (error) {
          errors.push({ path: relative, code: error.code || 'LINK_READ_FAILED' });
        }
      } else if (stat.isDirectory()) {
        visit(filePath, relative);
      } else if (stat.isFile()) {
        try {
          entries.set(relative, { type: 'FILE', digest: sha256(fs.readFileSync(filePath)) });
        } catch (error) {
          errors.push({ path: relative, code: error.code || 'READ_FAILED' });
        }
      } else {
        entries.set(relative, { type: 'OTHER', digest: null });
      }
    }
  }
  visit(root);
  return { available: errors.length === 0, entries, errors };
}

function gitSnapshot(root) {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const filesystem = filesystemSnapshot(root);
  if (status.error || status.status !== 0 || head.error || head.status !== 0) return { available: false, entries: new Map(), digests: new Map(), filesystem, head: null };
  const entries = parseStatus(status.stdout);
  const digests = new Map([...entries.keys()].map((relative) => [relative, fileDigest(root, relative)]));
  return { available: filesystem.available, entries, digests, filesystem, head: String(head.stdout || '').trim() };
}

function compareSnapshots(before, after, allowedFiles) {
  const allowed = new Set(allowedFiles);
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const beforeFilesystem = before.filesystem?.entries || new Map();
  const afterFilesystem = after.filesystem?.entries || new Map();
  const filesystemPaths = new Set([...beforeFilesystem.keys(), ...afterFilesystem.keys()]);
  for (const relative of filesystemPaths) paths.add(relative);
  const foreignChanges = [];
  const deletions = [];
  const allowedChanges = [];
  for (const relative of paths) {
    const beforeCode = before.entries.get(relative) || null;
    const afterCode = after.entries.get(relative) || null;
    const beforeDigest = before.digests.get(relative) || null;
    const afterDigest = after.digests.get(relative) || null;
    const beforeFilesystemEntry = beforeFilesystem.get(relative) || null;
    const afterFilesystemEntry = afterFilesystem.get(relative) || null;
    const filesystemChanged = JSON.stringify(beforeFilesystemEntry) !== JSON.stringify(afterFilesystemEntry);
    const changed = beforeCode !== afterCode || beforeDigest !== afterDigest || filesystemChanged;
    if (!changed) continue;
    if (!afterFilesystemEntry || (!afterDigest && afterCode && /D/.test(afterCode))) deletions.push(relative);
    if (allowed.has(relative)) allowedChanges.push(relative);
    else foreignChanges.push({ path: relative, before: beforeCode || beforeFilesystemEntry?.type || null, after: afterCode || afterFilesystemEntry?.type || null, observation: filesystemChanged && (beforeCode !== afterCode || beforeDigest !== afterDigest) ? 'GIT_AND_FILESYSTEM' : filesystemChanged ? 'FILESYSTEM' : 'GIT' });
  }
  const filesystemAvailable = before.filesystem ? before.filesystem.available && after.filesystem?.available : true;
  const boundaryViolations = [...afterFilesystem.entries()]
    .filter(([relative, entry]) => allowed.has(relative) && entry.type === 'SYMLINK')
    .map(([relative]) => relative);
  return {
    clean: foreignChanges.length === 0 && deletions.length === 0 && boundaryViolations.length === 0 && before.head === after.head && filesystemAvailable,
    allowedChanges: [...new Set(allowedChanges)].sort(),
    foreignChanges,
    deletions,
    headChanged: before.head !== after.head,
    confinement: {
      verified: filesystemAvailable,
      gitAudit: before.available && after.available ? 'OBSERVED' : 'UNAVAILABLE',
      repositoryFilesystem: filesystemAvailable ? 'OBSERVED' : 'INCOMPLETE',
      externalPaths: 'NOT_OBSERVABLE',
      boundaryViolations,
      note: 'Git and repository filesystem observations do not prove absence of effects outside the repository.'
    },
  };
}

function validateLot(root, lot) {
  if (!lot || lot.status !== 'READY') return { status: 'BLOCKED', reason: `Lot is not executable: ${lot?.status || 'UNKNOWN'}.` };
  if (!Array.isArray(lot.files) || !lot.files.length || lot.files.some((file) => !normalizeRelative(root, file))) return { status: 'BLOCKED', reason: 'Lot does not provide a bounded, repository-relative file allowlist.' };
  const allowedFiles = [...new Set(lot.files.map((file) => normalizeRelative(root, file)))].sort();
  if (allowedFiles.some((file) => isProtectedPath(file))) return { status: 'BLOCKED', reason: 'Lot includes a protected policy, governance or Quality Audit Kit artifact.' };
  const physicalFiles = {};
  for (const file of allowedFiles) {
    const boundary = physicalFileBoundary(root, file);
    if (boundary.status !== 'VALID') return { status: 'BLOCKED', reason: `Allowlist boundary rejected for ${file}: ${boundary.reason}` };
    physicalFiles[file] = boundary.realPath;
  }
  return { status: 'READY', allowedFiles, physicalFiles, boundary: { mode: 'PHYSICAL_NO_SYMLINKS', externalDestinations: 'REJECTED' } };
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
    'Do not modify any other file. Do not create or delete files. Do not commit, amend, reset, checkout, push, change a baseline, change decisions, change policy, install dependencies, publish data or contact a service. Do not run repository validation scripts unless the caller separately authorizes a declared validation. Stop and report BLOCKED if the correction requires anything outside the allowlist or if a pre-existing change is present in an approved file.',
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
    return Object.keys(packageJson.scripts || {}).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) && /^(test|check|lint|typecheck|type-check|validate|verify)([:._-]|$)/i.test(name)).sort();
  } catch {
    return [];
  }
}

function validationMetadata(root) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return {
      packageJson,
      scripts: packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {},
      declarations: packageJson.qualityAuditKit?.validationPolicy?.scripts || {},
    };
  } catch {
    return { packageJson: null, scripts: {}, declarations: {} };
  }
}

function forbiddenValidationEffect(script) {
  const source = String(script || '');
  const patterns = [
    [/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|mkdir|mkdirSync|rm|rmSync)\b/i, 'filesystem mutation'],
    [/(^|[\s"'])>{1,2}([^=]|$)/, 'shell redirection'],
    [/\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'network command'],
    [/\b(?:fetch|https?\.request|net\.connect)\s*\(/i, 'network API'],
    [/(?:git\s+(?:reset|clean|checkout|push|commit)|npm\s+publish|Remove-Item|\bdel\s+)/i, 'repository or external mutation'],
  ];
  const match = patterns.find(([pattern]) => pattern.test(source));
  return match ? match[1] : null;
}

function validationPackageManager(root, packageJson) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  const declared = String(packageJson?.packageManager || '').toLowerCase();
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('yarn@')) return 'yarn';
  if (declared.startsWith('bun@')) return 'bun';
  return 'npm';
}

function validationHooks(scripts, name) {
  return [
    ['pre', `pre${name}`],
    ['post', `post${name}`],
  ].filter(([, hookName]) => typeof scripts?.[hookName] === 'string')
    .map(([phase, hookName]) => ({ phase, name: hookName }));
}

function validationCommand(packageManager, name) {
  // npm's documented --ignore-scripts mode still runs the explicitly named
  // script while suppressing its implicit pre/post scripts. The other
  // managers are fail-closed below until their exact hook semantics can be
  // proved for the detected version and invocation.
  return packageManager === 'npm' ? ['--ignore-scripts', 'run', name] : ['run', name];
}

function runValidations(root, options = {}) {
  const names = validationNames(root);
  if (!names.length) return { status: 'NOT_RUN', validations: [], reason: 'No safe validation script was detected.' };
  const authorizedNames = [...new Set((Array.isArray(options.authorizedNames) ? options.authorizedNames : []).map((name) => String(name).trim()).filter(Boolean))].sort();
  const metadata = validationMetadata(root);
  if (!authorizedNames.length) return {
    status: 'BLOCKED',
    validations: [],
    candidates: names,
    authorization: { required: true, received: false, names: [] },
    effectBoundary: 'NOT_EXECUTED',
    reason: 'Validation scripts are not safe by name alone; explicit validation authorization is required.',
  };
  if (authorizedNames.some((name) => !names.includes(name))) return {
    status: 'BLOCKED',
    validations: [],
    candidates: names,
    authorization: { required: true, received: true, names: authorizedNames },
    effectBoundary: 'NOT_EXECUTED',
    reason: 'An explicitly authorized validation is not a detected package script.',
  };
  const declarations = authorizedNames.map((name) => {
    const script = typeof metadata.scripts[name] === 'string' ? metadata.scripts[name] : null;
    const declaration = metadata.declarations && typeof metadata.declarations[name] === 'object' ? metadata.declarations[name] : null;
    const effects = declaration?.effects;
    const forbiddenEffect = forbiddenValidationEffect(script);
    const valid = Boolean(script && declaration
      && declaration.scriptSha256 === sha256(script)
      && effects?.read === 'repository'
      && effects?.write === 'none'
      && effects?.network === 'none'
      && effects?.external === 'none'
      && effects?.subprocesses === 'declared-only'
      && !forbiddenEffect);
    return { name, scriptSha256: script ? sha256(script) : null, declaration, valid, forbiddenEffect };
  });
  if (declarations.some((item) => !item.valid)) return {
    status: 'BLOCKED',
    validations: [],
    candidates: names,
    authorization: { required: true, received: true, names: authorizedNames },
    effectBoundary: 'NOT_EXECUTED',
    invalidDeclarations: declarations.map((item) => ({ name: item.name, scriptSha256: item.scriptSha256, forbiddenEffect: item.forbiddenEffect || null })),
    reason: 'Each validation must declare the exact script hash and bounded effects (repository read, no writes, no network, declared subprocesses).',
  };
  const packageManager = validationPackageManager(root, metadata.packageJson);
  const hooks = declarations.map((item) => ({ name: item.name, hooks: validationHooks(metadata.scripts, item.name) }));
  if (packageManager !== 'npm') return {
    status: 'BLOCKED',
    validations: [],
    candidates: names,
    skipped: names.filter((name) => !authorizedNames.includes(name)),
    authorization: { required: true, received: true, names: authorizedNames },
    effectBoundary: 'NOT_EXECUTED',
    executionScope: {
      packageManager,
      explicitScripts: authorizedNames,
      implicitHooks: 'NOT_PROVEN_SUPPRESSED',
      hooks,
      externalEffects: 'NOT_OBSERVABLE',
    },
    reason: `Validation is blocked: hook suppression is not proven for ${packageManager}.`,
  };
  const validations = [];
  for (const item of declarations) {
    const name = item.name;
    const manager = packageManager;
    const executable = process.platform === 'win32' && manager === 'npm' ? 'npm.cmd' : manager;
    const command = validationCommand(manager, name);
    const result = process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd')
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${executable} ${command.join(' ')}`], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 })
      : spawnSync(executable, command, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const hookInfo = hooks.find((entry) => entry.name === name);
    validations.push({
      name,
      status: result.status === 0 ? 'PASS' : result.error?.code === 'ETIMEDOUT' ? 'BLOCKED' : 'FAIL',
      exitCode: result.status,
      command: `${executable} ${command.join(' ')}`,
      scriptSha256: item.scriptSha256,
      declaredEffects: item.declaration.effects,
      executionScope: {
        packageManager: manager,
        explicitScript: name,
        implicitHooks: 'SUPPRESSED_BY_IGNORE_SCRIPTS',
        suppressedHooks: hookInfo?.hooks || [],
        externalEffects: 'NOT_OBSERVABLE',
      },
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    });
  }
  return {
    status: validations.every((item) => item.status === 'PASS') ? 'PASS' : validations.some((item) => item.status === 'BLOCKED') ? 'BLOCKED' : 'FAIL',
    validations,
    candidates: names,
    skipped: names.filter((name) => !authorizedNames.includes(name)),
    authorization: { required: true, received: true, names: authorizedNames },
    executionScope: {
      packageManager,
      explicitScripts: authorizedNames,
      implicitHooks: 'SUPPRESSED_BY_IGNORE_SCRIPTS',
      hooks,
      externalEffects: 'NOT_OBSERVABLE',
    },
    effectBoundary: 'DECLARED_ONLY_POST_AUDIT',
    externalEffects: 'NOT_OBSERVABLE',
    reason: 'The declared validation ran with explicit authorization; post-run repository observations do not prove absence of external effects.',
  };
}

function classifyExecution(execution, scope, reanalysis, validations, executionBoundary) {
  if (execution.status !== 'COMPLETED') return 'FAILED';
  if (!scope.clean || scope.headChanged) return 'FAILED';
  if (scope.confinement?.verified === false) return 'UNVERIFIED';
  if (executionBoundary && executionBoundary.status !== 'REPOSITORY_BOUNDARY_ENFORCED_BY_ADAPTER') return 'UNVERIFIED';
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

async function executeFix({ plan, next, root, agentName = 'codex', agentOptions = {}, validationOptions = {}, approve = false, execute = approve, adapter, reanalyze = reanalyzeLot, validate = runValidations }) {
  const lotCheck = validateLot(root, next.lot);
  if (next.status !== 'READY' || lotCheck.status !== 'READY') return previewFix(plan, next.status === 'READY' ? { ...next, status: lotCheck.status, reason: lotCheck.reason } : next, 'NOT_RUN');
  if (!execute) return previewFix(plan, next, 'NOT_RUN');
  if (!approve) return redactResult({ ...previewFix(plan, next, 'NOT_RUN'), mode: 'BLOCKED', status: 'BLOCKED', reason: 'Explicit --approve is required before an agent may execute.' });
  const selectedAdapter = adapter || createAgentAdapter(agentName, agentOptions);
  if (selectedAdapter.capabilities?.strongWorkspaceConfinement !== true) return redactResult({
    ...previewFix(plan, next, 'NOT_RUN'),
    mode: 'BLOCKED',
    status: 'BLOCKED',
    reason: 'No strong cross-platform workspace confinement is available for this agent adapter; no agent was executed.',
    agent: { name: selectedAdapter.name, protocolVersion: selectedAdapter.protocolVersion, capabilities: selectedAdapter.capabilities },
    executionBoundary: { status: 'UNAVAILABLE', externalPaths: 'NOT_OBSERVABLE', gitAuditIsNotConfinement: true },
  });
  const allowedFiles = lotCheck.allowedFiles;
  const before = gitSnapshot(root);
  if (!before.available || !before.filesystem?.available) return redactResult({ ...previewFix(plan, next, 'NOT_RUN'), mode: 'BLOCKED', status: 'BLOCKED', reason: 'Git or repository filesystem state is unavailable; the workflow cannot prove preservation of pre-existing changes.' });
  const dirtyApproved = allowedFiles.filter((file) => before.entries.has(file));
  if (dirtyApproved.length) return redactResult({ ...previewFix(plan, next, 'NOT_RUN'), mode: 'BLOCKED', status: 'BLOCKED', reason: 'Approved files already contain pre-existing changes; they are not overwritten.', dirtyApprovedFiles: dirtyApproved });
  const prompt = boundedPrompt(next.lot, allowedFiles);
  const executionBoundary = selectedAdapter.capabilities.externalEffects === 'NONE'
    ? { status: 'REPOSITORY_BOUNDARY_ENFORCED_BY_ADAPTER', mechanism: 'PHYSICAL_ALLOWLIST_NO_SYMLINKS', externalPaths: 'NOT_APPLICABLE', gitAuditIsNotConfinement: true }
    : { status: 'REPOSITORY_BOUNDARY_OBSERVED_ONLY', mechanism: 'PHYSICAL_ALLOWLIST_NO_SYMLINKS', externalPaths: 'NOT_OBSERVABLE', gitAuditIsNotConfinement: true };
  let execution;
  try {
    execution = await selectedAdapter.execute({ root, prompt, lot: next.lot, allowedFiles, allowedPhysicalFiles: lotCheck.physicalFiles });
  } catch (error) {
    execution = { status: 'FAILED', exitCode: null, stdout: '', stderr: error.message || 'Agent execution failed.', command: selectedAdapter.name, lastMessage: '' };
  }
  const after = gitSnapshot(root);
  const executionScope = compareSnapshots(before, after, allowedFiles);
  const reanalysis = execution.status === 'COMPLETED' && executionScope.clean && !executionScope.headChanged ? await reanalyze(root, next.lot) : { status: 'BLOCKED', reason: 'Agent failure, scope or Git history changed; targeted reanalysis was not trusted.' };
  const validations = execution.status === 'COMPLETED' && executionScope.clean && !executionScope.headChanged ? validate(root, next.lot, validationOptions) : { status: 'BLOCKED', validations: [], reason: 'Agent failure, scope or Git history changed.' };
  const finalScope = compareSnapshots(before, gitSnapshot(root), allowedFiles);
  return redactResult({
    schemaVersion: '0.1-draft',
    fixVersion: '0.1-draft',
    kind: 'QUALITY_FIX_RESULT',
    mode: 'EXECUTION',
    status: classifyExecution(execution, finalScope, reanalysis, validations, executionBoundary),
    planId: plan.planId,
    runId: plan.runId,
    lotId: next.lot.id,
    agent: { name: selectedAdapter.name, protocolVersion: selectedAdapter.protocolVersion, capabilities: selectedAdapter.capabilities },
    authorization: { required: true, received: true, execution: 'EXPLICIT_APPROVAL' },
    allowedFiles,
    executionBoundary,
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
  if (result.executionBoundary?.status !== 'REPOSITORY_BOUNDARY_ENFORCED_BY_ADAPTER' || result.executionBoundary?.externalPaths !== 'NOT_APPLICABLE' || result.agent?.capabilities?.strongWorkspaceConfinement !== true || result.agent?.capabilities?.externalEffects !== 'NONE') return { command: 'verify', status: 'UNVERIFIED', verified: false, reason: 'The artifact does not prove a strong repository execution boundary with no unobserved external effects.' };
  if (result.status === 'RESOLVED' && result.reanalysis?.status === 'MEASURED_VERIFIED' && result.validations?.status === 'PASS') return { command: 'verify', status: 'RESOLVED', verified: true, reason: 'Targeted findings are absent from a verified reanalysis and validations passed.' };
  return { command: 'verify', status: result.status === 'RESOLVED' ? 'UNVERIFIED' : result.status, verified: false, reason: 'The recorded evidence is insufficient to prove a resolved correction.' };
}

module.exports = { FIX_STATUSES, boundedPrompt, classifyExecution, compareSnapshots, executeFix, gitSnapshot, previewFix, reanalyzeLot, runValidations, validateLot, verifyFixResult };
