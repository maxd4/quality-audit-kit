const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_FILES = {
  handoff: 'PROJECT_HANDOFF.md',
  review: 'COMMIT_REVIEW.md',
};

const MARKERS = {
  generatedStart: '<!-- QAK:BEGIN GENERATED -->',
  generatedEnd: '<!-- QAK:END GENERATED -->',
  manualStart: '<!-- QAK:BEGIN MANUAL -->',
  manualEnd: '<!-- QAK:END MANUAL -->',
  decisionsStart: '<!-- QAK:BEGIN USER_DECISIONS -->',
  decisionsEnd: '<!-- QAK:END USER_DECISIONS -->',
  factsStart: '<!-- QAK:BEGIN DETECTED_FACTS -->',
  factsEnd: '<!-- QAK:END DETECTED_FACTS -->',
  controlsStart: '<!-- QAK:BEGIN DETECTED_CONTROLS -->',
  controlsEnd: '<!-- QAK:END DETECTED_CONTROLS -->',
  agentsStart: '<!-- QAK:BEGIN AGENTS_LINK -->',
  agentsEnd: '<!-- QAK:END AGENTS_LINK -->',
};

function display(value) {
  if (value === null || value === undefined || value === '') return 'UNKNOWN';
  return String(value);
}

function list(values, empty = 'NONE_DETECTED') {
  if (!Array.isArray(values) || values.length === 0) return `- ${empty}`;
  return values.map((value) => `- ${display(value)}`).join('\n');
}

function scannerLine(scanner) {
  const status = scanner.installed ? 'INSTALLED_LOCAL' : 'NOT_INSTALLED';
  const configurations = scanner.configuration.length ? scanner.configuration.join(', ') : 'NONE_DETECTED';
  const scripts = scanner.scripts.length ? scanner.scripts.join(', ') : 'NONE_DETECTED';
  return `- ${scanner.name}: ${status}; configurations=${configurations}; packageConfiguration=${scanner.packageConfiguration ? 'DETECTED' : 'NONE_DETECTED'}; scripts=${scripts}`;
}

function detectedFacts(discovery) {
  const packageManager = discovery.packageManager?.name
    ? `${discovery.packageManager.name} (${discovery.packageManager.lockfile})`
    : 'UNKNOWN';
  const workspaces = discovery.workspaces?.packages?.length
    ? discovery.workspaces.packages
    : discovery.workspaces?.declared?.length
      ? discovery.workspaces.declared
      : [];
  const scanners = discovery.scanners?.length ? discovery.scanners.map(scannerLine).join('\n') : '- UNKNOWN';
  const files = discovery.projectFiles || [];
  const git = discovery.git || {};
  return [
    '## Detected facts (machine-generated)',
    '',
    'These values are observations from the target repository. They are not an architectural or security conclusion.',
    '',
    `- Repository name: ${display(discovery.repositoryName)}`,
    `- Repository root: ${display(discovery.root)}`,
    `- Package manager: ${packageManager}`,
    `- Languages detected by extension: ${discovery.languages?.length ? discovery.languages.join(', ') : 'NONE_DETECTED'}`,
    `- Declared workspace patterns: ${discovery.workspaces?.declared?.length ? discovery.workspaces.declared.join(', ') : 'NONE_DETECTED'}`,
    `- Workspace package paths: ${workspaces.length ? workspaces.join(', ') : 'NONE_DETECTED'}`,
    `- Git branch: ${display(git.branch)}`,
    `- Git HEAD: ${display(git.head)}`,
    `- Git worktree: ${display(git.worktree)}`,
    '',
    '### Detected scanners and configurations',
    '',
    scanners,
    '',
    '### Candidate files to inspect',
    '',
    list(files),
    '',
    '### Unknowns that require direct inspection',
    '',
    '- Purpose and users: UNKNOWN',
    '- Architecture and runtime boundaries: UNKNOWN',
    '- Authoritative sources for each domain: UNKNOWN',
    '- Security, privacy and deployment guarantees: UNKNOWN',
  ].join('\n');
}

function handoffManual() {
  return [
    '## User-maintained context',
    '',
    'Edit this section deliberately. The updater preserves it byte-for-byte, including decisions and exceptions.',
    '',
    '### Project purpose and scope',
    '',
    '- Purpose: UNKNOWN',
    '- In scope: UNKNOWN',
    '- Out of scope: UNKNOWN',
    '',
    '### Architecture',
    '',
    '- Runtime components and boundaries: UNKNOWN',
    '- Data flows and external systems: UNKNOWN',
    '- Build, test and release path: UNKNOWN',
    '',
    '### Sources of truth',
    '',
    '- Code or contract source of truth: UNKNOWN',
    '- Documentation source of truth: UNKNOWN',
    '- Configuration and operational source of truth: UNKNOWN',
    '- If sources conflict, resolution rule: UNKNOWN',
    '',
    '### Current state',
    '',
    '- Delivered behavior: UNKNOWN',
    '- Known limitations: UNKNOWN',
    '- Open risks: UNKNOWN',
    '- Next safe action: UNKNOWN',
    '',
    MARKERS.decisionsStart,
    '### User decisions and accepted exceptions',
    '',
    '- Decision: UNKNOWN',
    '- Rationale: UNKNOWN',
    '- Owner/date: UNKNOWN',
    MARKERS.decisionsEnd,
  ].join('\n');
}

function reviewManual() {
  return [
    '## User-maintained review controls',
    '',
    'Edit this section to record repository-specific review decisions. The updater preserves it byte-for-byte.',
    '',
    '### Review scope',
    '',
    '- Commit range or candidate: UNKNOWN',
    '- Domain and invariants under review: UNKNOWN',
    '- Explicit exclusions: UNKNOWN',
    '',
    '### Repository-specific controls',
    '',
    '- Required checks: UNKNOWN',
    '- Required reviewers or owners: UNKNOWN',
    '- Deployment, migration or runtime evidence required: UNKNOWN',
    '- Accepted baseline or exceptions: UNKNOWN',
    '',
    '### Review decisions and evidence',
    '',
    '- Decision: UNKNOWN',
    '- Evidence link or command: UNKNOWN',
    '- Remaining uncertainty: UNKNOWN',
  ].join('\n');
}

function genericReviewProtocol() {
  return [
    '## Generic review protocol (machine-generated)',
    '',
    'This section is repository-independent. Extend it only with demonstrated controls from the target repository.',
    '',
    '### Agent instructions',
    '',
    '1. Inspect the real repository, applicable AGENTS files, documentation, configurations, tests and the final code before making claims.',
    '2. Separate FACT (directly observed), INFERENCE (reasoned and labelled) and UNKNOWN (not demonstrated).',
    '3. Fix the review scope to an explicit commit, candidate or worktree state; do not mix moving states.',
    '4. Review the changed behavior and the directly affected existing behavior, including consumers and tests.',
    '5. Treat absent, skipped or failed controls as NOT_MEASURED or FAILURE, never as a clean result.',
    '6. Keep repository mutation outside the approved files out of scope; do not install dependencies implicitly.',
    '7. Report test and CI evidence with the exact command, target and result. Do not present agent execution as independent validation.',
    '',
    '### Minimum review sequence',
    '',
    '- Identify the actual repository state and review boundary.',
    '- Read applicable governance, contracts, documentation, configuration and tests.',
    '- Inspect the full final diff and affected consumers.',
    '- Run the narrowest meaningful checks, then expand only for demonstrated risk.',
    '- Record PASS, FAIL, BLOCKED or NOT_RUN for every intended control.',
    '- Re-check the final state before closing the review.',
    '',
    '### Generic review checklist',
    '',
    '- Scope and provenance are explicit.',
    '- Inputs, errors, permissions, persistence and side effects are covered where relevant.',
    '- Documentation and tests agree with the final behavior.',
    '- Secrets and sensitive data are not published or logged.',
    '- A missing tool or failed command is visible as uncertainty.',
  ].join('\n');
}

function detectedControls(discovery) {
  const scripts = discovery.scripts || [];
  const files = discovery.projectFiles || [];
  const tests = files.filter((file) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(file));
  const workflows = files.filter((file) => file.startsWith('.github/workflows/'));
  const rules = files.filter((file) => /(?:^|\/)(?:AGENTS(?:\.override)?\.md|CONTRIBUTING\.md|SECURITY\.md|\.editorconfig|\.gitignore|LICENSE|NOTICE)$/.test(file));
  const licenses = files.filter((file) => /(?:^|\/)(?:LICENSE|COPYING)(?:\.|$)/i.test(file));
  return [
    '## Detected repository controls (machine-generated)',
    '',
    'The following inventory is evidence of files or package metadata, not proof that a control passes.',
    '',
    `- Package scripts: ${scripts.length ? scripts.join(', ') : 'UNKNOWN'}`,
    `- Test-like paths: ${tests.length ? tests.join(', ') : 'NONE_DETECTED'}`,
    `- CI workflow paths: ${workflows.length ? workflows.join(', ') : 'NONE_DETECTED'}`,
    `- Governance and security files: ${rules.length ? rules.join(', ') : 'NONE_DETECTED'}`,
    `- License files: ${licenses.length ? licenses.join(', ') : 'UNKNOWN'}`,
    '',
    '### Scanner controls',
    '',
    discovery.scanners?.length ? discovery.scanners.map(scannerLine).join('\n') : '- UNKNOWN',
    '',
    '### Control status to complete after execution',
    '',
    '- Tests: NOT_MEASURED',
    '- Lint/type checks: NOT_MEASURED',
    '- CI: NOT_MEASURED',
    '- Security and secret checks: NOT_MEASURED',
    '- License review: NOT_MEASURED',
    '- Runtime or deployment checks: NOT_MEASURED',
  ].join('\n');
}

function renderTemplate(kind, discovery, customGenerated) {
  const title = kind === 'handoff' ? 'PROJECT_HANDOFF' : 'COMMIT_REVIEW';
  const factualBlock = kind === 'handoff'
    ? [MARKERS.factsStart, detectedFacts(discovery), MARKERS.factsEnd].join('\n')
    : [MARKERS.controlsStart, detectedControls(discovery), MARKERS.controlsEnd].join('\n');
  const generated = kind === 'handoff'
    ? [
      '## Agent instructions (generic, machine-generated)',
      '',
      'Read the detected files and the real repository before completing this document. Never promote an inference to a fact. Keep UNKNOWN when evidence is missing.',
      '',
      factualBlock,
    ].join('\n')
    : [genericReviewProtocol(), '', factualBlock].join('\n');
  const generatedContent = customGenerated || generated;
  const manual = kind === 'handoff' ? handoffManual() : reviewManual();
  return [
    `# ${title}`,
    '',
    '> Generated by quality-audit-kit. The managed block is refreshable; the manual block is protected.',
    '',
    MARKERS.generatedStart,
    generatedContent.trim(),
    MARKERS.generatedEnd,
    '',
    MARKERS.manualStart,
    manual.trim(),
    MARKERS.manualEnd,
    '',
  ].join('\n');
}

function markerCount(content, marker) {
  return content.split(marker).length - 1;
}

function extractBlock(content, start, end) {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return null;
  return { startIndex, endIndex, endAfter: endIndex + end.length };
}

function mergeManagedDocument(existing, proposed) {
  if (existing === null || existing === undefined) return { content: proposed, created: true, changed: true };
  const generated = extractBlock(existing, MARKERS.generatedStart, MARKERS.generatedEnd);
  const manual = extractBlock(existing, MARKERS.manualStart, MARKERS.manualEnd);
  const valid = generated && manual
    && markerCount(existing, MARKERS.generatedStart) === 1
    && markerCount(existing, MARKERS.generatedEnd) === 1
    && markerCount(existing, MARKERS.manualStart) === 1
    && markerCount(existing, MARKERS.manualEnd) === 1;
  if (!valid) {
    return { content: existing, changed: false, unsafe: true, reason: 'existing document is not a managed quality-audit-kit template' };
  }
  const proposedGenerated = extractBlock(proposed, MARKERS.generatedStart, MARKERS.generatedEnd);
  const replacement = proposed.slice(proposedGenerated.startIndex, proposedGenerated.endAfter);
  const content = `${existing.slice(0, generated.startIndex)}${replacement}${existing.slice(generated.endAfter)}`;
  return { content, changed: content !== existing, created: false };
}

function factualMarkers(kind) {
  return kind === 'handoff'
    ? { start: MARKERS.factsStart, end: MARKERS.factsEnd, heading: '## Detected facts (machine-generated)' }
    : { start: MARKERS.controlsStart, end: MARKERS.controlsEnd, heading: '## Detected repository controls (machine-generated)' };
}

function extractFactualContent(content, generatedBlock, kind) {
  const markers = factualMarkers(kind);
  const nested = extractBlock(content, markers.start, markers.end);
  if (nested && markerCount(content, markers.start) === 1 && markerCount(content, markers.end) === 1) {
    return content.slice(nested.startIndex + markers.start.length, nested.endIndex).trim();
  }
  const legacyStart = content.indexOf(markers.heading, generatedBlock.startIndex);
  if (legacyStart >= 0 && legacyStart < generatedBlock.endIndex) {
    return content.slice(legacyStart, generatedBlock.endIndex).trim();
  }
  return null;
}

function parseFactMap(content) {
  const facts = new Map();
  if (!content) return facts;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+?)\s*$/);
    if (!match) continue;
    facts.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return facts;
}

function normalizeFactValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractFactChanges(existing, proposed, kind) {
  const existingGenerated = extractBlock(existing, MARKERS.generatedStart, MARKERS.generatedEnd);
  const proposedGenerated = extractBlock(proposed, MARKERS.generatedStart, MARKERS.generatedEnd);
  if (!existingGenerated || !proposedGenerated) return { changedFacts: [], contradictions: [] };
  const previousFacts = parseFactMap(extractFactualContent(existing, existingGenerated, kind));
  const currentFacts = parseFactMap(extractFactualContent(proposed, proposedGenerated, kind));
  const manual = extractBlock(existing, MARKERS.manualStart, MARKERS.manualEnd);
  const manualText = manual ? existing.slice(manual.startIndex, manual.endAfter) : '';
  const manualFacts = parseFactMap(manualText);
  const changedFacts = [];
  const contradictions = [];
  for (const [field, currentValue] of currentFacts.entries()) {
    const previousValue = previousFacts.get(field);
    if (previousValue === undefined || normalizeFactValue(previousValue) === normalizeFactValue(currentValue)) continue;
    const change = { field, previous: previousValue, current: currentValue };
    changedFacts.push(change);
    const manualValue = manualFacts.get(field);
    if (manualValue && normalizeFactValue(manualValue) !== 'unknown' && normalizeFactValue(manualValue) !== normalizeFactValue(currentValue)) {
      contradictions.push({
        field,
        previous: previousValue,
        current: currentValue,
        manual: manualValue,
        status: 'CONTRADICTION',
      });
    }
  }
  return { changedFacts, contradictions };
}

function refreshManagedDocument(existing, proposed, kind) {
  if (existing === null || existing === undefined) return { content: existing, changed: false, missing: true };
  const generated = extractBlock(existing, MARKERS.generatedStart, MARKERS.generatedEnd);
  const manual = extractBlock(existing, MARKERS.manualStart, MARKERS.manualEnd);
  const valid = generated && manual
    && markerCount(existing, MARKERS.generatedStart) === 1
    && markerCount(existing, MARKERS.generatedEnd) === 1
    && markerCount(existing, MARKERS.manualStart) === 1
    && markerCount(existing, MARKERS.manualEnd) === 1;
  if (!valid) return { content: existing, changed: false, unsafe: true, reason: 'existing document is not a managed quality-audit-kit template' };
  const proposedGenerated = extractBlock(proposed, MARKERS.generatedStart, MARKERS.generatedEnd);
  const proposedFacts = factualMarkers(kind);
  const proposedNested = extractBlock(proposed, proposedFacts.start, proposedFacts.end);
  const currentNested = extractBlock(existing, proposedFacts.start, proposedFacts.end);
  const nestedMarkersPresent = existing.includes(proposedFacts.start) || existing.includes(proposedFacts.end);
  if (nestedMarkersPresent
    && (markerCount(existing, proposedFacts.start) !== 1 || markerCount(existing, proposedFacts.end) !== 1)) {
    return { content: existing, changed: false, unsafe: true, reason: 'managed document has malformed detected-facts markers' };
  }
  let replacement;
  let currentStart;
  let currentEnd;
  if (currentNested && markerCount(existing, proposedFacts.start) === 1 && markerCount(existing, proposedFacts.end) === 1) {
    currentStart = currentNested.startIndex;
    currentEnd = currentNested.endAfter;
  } else {
    currentStart = existing.indexOf(proposedFacts.heading, generated.startIndex);
    currentEnd = generated.endIndex;
  }
  if (!proposedNested || currentStart < 0 || currentEnd < currentStart) {
    return { content: existing, changed: false, unsafe: true, reason: 'managed document has no refreshable detected-facts block' };
  }
  replacement = proposed.slice(proposedNested.startIndex, proposedNested.endAfter);
  const content = `${existing.slice(0, currentStart)}${replacement}${existing.slice(currentEnd)}`;
  return { content, changed: content !== existing };
}

function diffPreview(filePath, before, after) {
  if (before === after) return `No changes: ${filePath}`;
  const beforeLines = (before || '').split(/\r?\n/);
  const afterLines = (after || '').split(/\r?\n/);
  const lines = [`--- ${filePath} (existing)`, `+++ ${filePath} (proposed)`, '@@'];
  for (const line of beforeLines.slice(0, 120)) lines.push(`-${line}`);
  for (const line of afterLines.slice(0, 120)) lines.push(`+${line}`);
  if (beforeLines.length > 120 || afterLines.length > 120) lines.push('... diff preview truncated ...');
  return lines.join('\n');
}

function buildAgentPrompt(discovery) {
  return [
    '# quality-audit-kit template customization request',
    '',
    'You have explicit permission to propose content for the two generated blocks only.',
    'Inspect the real repository files, configurations, documentation, tests and applicable rules listed below before writing anything.',
    'Use FACT for direct evidence, INFERENCE only when labelled, and UNKNOWN when the repository does not demonstrate a claim.',
    'Do not copy product-specific rules from another repository. Do not include secrets. Do not modify the analyzed repository.',
    '',
    `Repository root: ${display(discovery.root)}`,
    `Detected files: ${discovery.projectFiles?.length ? discovery.projectFiles.join(', ') : 'NONE_DETECTED'}`,
    '',
    'Return a JSON object with exactly these optional string properties:',
    '- projectHandoffGenerated',
    '- commitReviewGenerated',
    'Each value must contain only the content that belongs between the QAK generated markers. Do not return marker lines.',
  ].join('\n');
}

function readAgentCustomization(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Agent input must be a JSON object.');
  const result = {};
  for (const [key, kind] of [['projectHandoffGenerated', 'handoff'], ['commitReviewGenerated', 'review']]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Agent input property ${key} must be a non-empty string.`);
    if (Object.values(MARKERS).some((marker) => value[key].includes(marker))) {
      throw new Error(`Agent input property ${key} must not contain QAK marker lines.`);
    }
    if (/-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*(?!UNKNOWN\b)\S+|\b(?:gh[pousr]|sk)-[A-Za-z0-9_-]{12,}\b/i.test(value[key])) {
      throw new Error(`Agent input property ${key} appears to contain a secret-like value.`);
    }
    result[kind] = value[key];
  }
  if (!Object.keys(result).length) throw new Error('Agent input must provide at least one generated block.');
  return result;
}

function mergeAgentsLink(existing) {
  const link = [
    MARKERS.agentsStart,
    'See [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for project context and [COMMIT_REVIEW.md](COMMIT_REVIEW.md) for the generic review protocol.',
    MARKERS.agentsEnd,
  ].join('\n');
  if (existing === null || existing === undefined) return { content: existing, changed: false, skipped: true, reason: 'AGENTS.md not found' };
  const block = extractBlock(existing, MARKERS.agentsStart, MARKERS.agentsEnd);
  if (block && markerCount(existing, MARKERS.agentsStart) === 1 && markerCount(existing, MARKERS.agentsEnd) === 1) {
    const content = `${existing.slice(0, block.startIndex)}${link}${existing.slice(block.endAfter)}`;
    return { content, changed: content !== existing };
  }
  if (existing.includes(MARKERS.agentsStart) || existing.includes(MARKERS.agentsEnd)) {
    return { content: existing, changed: false, unsafe: true, reason: 'AGENTS.md contains an incomplete quality-audit-kit link block' };
  }
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${existing}${separator}${link}\n`, changed: true };
}

function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = {
  MARKERS,
  TEMPLATE_FILES,
  buildAgentPrompt,
  diffPreview,
  extractFactChanges,
  mergeAgentsLink,
  mergeManagedDocument,
  readAgentCustomization,
  refreshManagedDocument,
  renderTemplate,
  writeIfChanged,
};
