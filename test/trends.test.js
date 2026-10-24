const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { compareMaintainabilityRuns, renderMaintainabilityTrendsMarkdown } = require('../src/trends');
const { buildStructuredReport, renderMarkdown } = require('../src/report');

const METRICS = [
  ['cognitiveComplexity', 'score', 'LOWER_IS_BETTER'],
  ['cyclomaticComplexity', 'score', 'LOWER_IS_BETTER'],
  ['functionLength', 'lines', 'LOWER_IS_BETTER'],
  ['decisionCount', 'decisions', 'LOWER_IS_BETTER'],
  ['maxDecisionDepth', 'levels', 'LOWER_IS_BETTER'],
  ['nestedDecisionCount', 'decisions', 'LOWER_IS_BETTER'],
  ['maxSubtreeDecisionCount', 'decisions', 'LOWER_IS_BETTER'],
];

function revision(character = 'a') {
  return { status: 'VERIFIED', sha: character.repeat(40), basis: 'synthetic committed snapshot' };
}

function measurement({ runKey, source, functionId, functionName, pathName, role = 'FUNCTION_DECLARATION', language = 'javascript', metricId, value, metricVersion = '1', engineVersion = '1.1.0' }) {
  const definition = METRICS.find(([id]) => id === metricId) || [metricId, 'score', 'LOWER_IS_BETTER'];
  return {
    measurementId: `${runKey}-${functionId}-${metricId}`,
    engine: 'maintainability',
    engineVersion,
    metricId,
    metricVersion,
    language,
    path: pathName,
    functionId,
    functionName,
    astRole: role,
    startLine: 10,
    endLine: 20,
    value,
    unit: definition[1],
    direction: definition[2],
    status: 'MEASURED',
    provenance: { kind: 'EXECUTION', reference: 'qak-lexical-ast@1.0.0', sourceRevision: revision(source), contentSha256: 'f'.repeat(64) },
    evidenceRef: `${pathName}#${functionId}:${metricId}`,
  };
}

function makeRun({ runKey, runId = `${runKey}-run-001`, source = runKey, values = {}, functions = [], engineStatus = 'MEASURED', coverageStatus = 'MEASURED', inputScope = 'COMMITTED_SNAPSHOT', engineVersion = '1.1.0', metricVersion = '1' } = {}) {
  const functionEntries = functions.length ? functions : [{ functionId: 'v1:function-1', functionName: 'processData', pathName: 'src/data.js' }];
  const functionMeasurements = functionEntries.flatMap((entry) => Object.entries(values[entry.functionId] || values[entry.functionName] || {
    cognitiveComplexity: 10,
    cyclomaticComplexity: 3,
    functionLength: 20,
    decisionCount: 2,
    maxDecisionDepth: 1,
    nestedDecisionCount: 0,
    maxSubtreeDecisionCount: 1,
  }).map(([metricId, value]) => measurement({ runKey, source, ...entry, metricId, value, metricVersion, engineVersion })));
  return {
    schemaVersion: '0.1-draft',
    runId,
    repository: { name: 'synthetic-repository', contextCommitSha: revision(source).sha },
    inputScope,
    reproducible: true,
    engines: [{ name: 'maintainability', version: engineVersion, measurementStatus: engineStatus, gateOutcome: engineStatus === 'MEASURED' ? 'INFORMATIVE' : 'NOT_EVALUATED', gateRelevant: false, sourceRevision: revision(source), scope: 'function' }],
    findings: [],
    functionMeasurements,
    maintainabilityCoverage: { schemaVersion: '0.1-draft', status: coverageStatus, eligibleFiles: [], measuredFiles: [], excludedFiles: [], unsupportedFiles: [], errorFiles: [], functionsMeasured: functionEntries.length, engines: [{ name: 'maintainability', version: engineVersion, parser: 'qak-lexical-ast@1.0.0' }] },
  };
}

test('compares increases, decreases, unchanged values, line shifts, additions, removals and zero-relative deltas', () => {
  const previous = makeRun({ runKey: 'previous', source: 'a', values: {
    'v1:function-1': { cognitiveComplexity: 10, cyclomaticComplexity: 3, functionLength: 20, decisionCount: 2, maxDecisionDepth: 1, nestedDecisionCount: 0, maxSubtreeDecisionCount: 1 },
    'v1:function-2': { cognitiveComplexity: 0, decisionCount: 0 },
    'v1:old': { cognitiveComplexity: 5 },
  }, functions: [
    { functionId: 'v1:function-1', functionName: 'processData', pathName: 'src/data.js' },
    { functionId: 'v1:function-2', functionName: 'zeroCase', pathName: 'src/data.js' },
    { functionId: 'v1:old', functionName: 'removedFunction', pathName: 'src/old.js' },
    { functionId: 'v1:shifted-old', functionName: 'shifted', pathName: 'src/shifted.js' },
  ] });
  const current = makeRun({ runKey: 'current', source: 'b', values: {
    'v1:function-1': { cognitiveComplexity: 15, cyclomaticComplexity: 2, functionLength: 20, decisionCount: 3, maxDecisionDepth: 2, nestedDecisionCount: 1, maxSubtreeDecisionCount: 2 },
    'v1:function-2': { cognitiveComplexity: 2, decisionCount: 1 },
    'v1:new': { cognitiveComplexity: 4 },
    'v1:shifted-new': { functionLength: 10 },
  }, functions: [
    { functionId: 'v1:function-1', functionName: 'processData', pathName: 'src/data.js' },
    { functionId: 'v1:function-2', functionName: 'zeroCase', pathName: 'src/data.js' },
    { functionId: 'v1:new', functionName: 'addedFunction', pathName: 'src/new.js' },
    { functionId: 'v1:shifted-new', functionName: 'shifted', pathName: 'src/shifted.js' },
  ] });
  const result = compareMaintainabilityRuns(previous, current);
  assert.equal(result.status, 'COMPARABLE');
  const process = result.functions.find((entry) => entry.current.functionName === 'processData');
  assert.equal(process.status, 'DEGRADED');
  assert.equal(process.matchedBy, 'FUNCTION_ID');
  assert.equal(process.metrics.find((metric) => metric.metricId === 'cognitiveComplexity').absoluteDelta, 5);
  assert.equal(process.metrics.find((metric) => metric.metricId === 'cyclomaticComplexity').status, 'IMPROVED');
  const zero = result.functions.find((entry) => entry.current.functionName === 'zeroCase');
  const zeroMetric = zero.metrics.find((metric) => metric.metricId === 'decisionCount');
  assert.equal(zeroMetric.currentValue, 1);
  assert.equal(zeroMetric.relativeDelta, null);
  assert.equal(zeroMetric.relativeStatus, 'UNDEFINED_PREVIOUS_ZERO');
  assert.equal(result.functions.find((entry) => entry.current.functionName === 'shifted').matchedBy, 'FUNCTION_SIGNATURE');
  assert.equal(result.addedFunctions.some((entry) => entry.functionName === 'addedFunction'), true);
  assert.equal(result.removedFunctions.some((entry) => entry.functionName === 'removedFunction'), true);
  assert.equal(result.summary.degraded >= 1, true);
});

test('does not demonstrate a rename, reports signature collisions and leaves absent metrics unmeasured', () => {
  const previous = makeRun({ runKey: 'previous', source: 'c', values: {
    'v1:rename-old': { cognitiveComplexity: 2 },
    'v1:collision-a': { cognitiveComplexity: 2 },
    'v1:collision-b': { functionLength: 20 },
  }, functions: [
    { functionId: 'v1:rename-old', functionName: 'oldName', pathName: 'src/file.js' },
    { functionId: 'v1:collision-a', functionName: 'sameName', pathName: 'src/collision.js' },
    { functionId: 'v1:collision-b', functionName: 'sameName', pathName: 'src/collision.js' },
  ] });
  const current = makeRun({ runKey: 'current', source: 'd', values: {
    'v1:rename-new': { cognitiveComplexity: 3 },
    'v1:collision-current': { cognitiveComplexity: 3 },
  }, functions: [
    { functionId: 'v1:rename-new', functionName: 'newName', pathName: 'src/file.js' },
    { functionId: 'v1:collision-current', functionName: 'sameName', pathName: 'src/collision.js' },
  ] });
  const result = compareMaintainabilityRuns(previous, current);
  assert.equal(result.status, 'COMPARABLE');
  assert.equal(result.functions.some((entry) => entry.current.functionName === 'oldName'), false);
  assert.equal(result.addedFunctions.some((entry) => entry.functionName === 'newName'), true);
  assert.equal(result.removedFunctions.some((entry) => entry.functionName === 'oldName'), true);
  assert.equal(result.nonComparableFunctions.some((entry) => entry.reason === 'FUNCTION_SIGNATURE_COLLISION'), true);
  const previousNoStructural = makeRun({ runKey: 'legacy', source: 'c', values: { 'v1:function-1': { cognitiveComplexity: 2 } } });
  const currentNoStructural = makeRun({ runKey: 'legacy-current', source: 'd', values: { 'v1:function-1': { cognitiveComplexity: 3 } } });
  const legacy = compareMaintainabilityRuns(previousNoStructural, currentNoStructural);
  const missing = legacy.functions[0].metrics.find((metric) => metric.metricId === 'decisionCount');
  assert.equal(missing.status, 'NOT_MEASURED');
  assert.equal(missing.previousValue, null);
  assert.equal(missing.currentValue, null);
});

test('rejects incompatible run contracts without manufacturing function deltas', () => {
  const basePrevious = makeRun({ runKey: 'previous', source: 'e' });
  const baseCurrent = makeRun({ runKey: 'current', source: 'f' });
  assert.equal(compareMaintainabilityRuns(basePrevious, { ...baseCurrent, runId: basePrevious.runId }).status, 'NOT_COMPARABLE');
  assert.equal(compareMaintainabilityRuns(basePrevious, { ...baseCurrent, repository: { name: 'other' } }).status, 'NOT_COMPARABLE');
  assert.equal(compareMaintainabilityRuns(basePrevious, makeRun({ runKey: 'partial', source: 'f', engineStatus: 'PARTIAL' })).status, 'NOT_COMPARABLE');
  assert.equal(compareMaintainabilityRuns(basePrevious, makeRun({ runKey: 'unknown', source: 'f' , inputScope: 'WORKTREE_LIVE' })).status, 'NOT_COMPARABLE');
  const incompatibleEngine = makeRun({ runKey: 'engine', source: 'f', engineVersion: '9.0.0' });
  assert.equal(compareMaintainabilityRuns(basePrevious, incompatibleEngine).status, 'NOT_COMPARABLE');
  const metricVersion = makeRun({ runKey: 'metric', source: 'f', metricVersion: '2' });
  const metricResult = compareMaintainabilityRuns(basePrevious, metricVersion);
  assert.equal(metricResult.status, 'COMPARABLE');
  assert.equal(metricResult.functions[0].metrics[0].status, 'NOT_COMPARABLE');
  const unknownRevision = makeRun({ runKey: 'unknown-revision', source: 'f' });
  unknownRevision.engines[0].sourceRevision = { status: 'UNKNOWN', sha: null, basis: 'not available' };
  assert.equal(compareMaintainabilityRuns(basePrevious, unknownRevision).status, 'NOT_COMPARABLE');
  const sameShaDifferentRuns = makeRun({ runKey: 'same-sha-current', source: 'e', runId: 'different-run-id' });
  assert.equal(compareMaintainabilityRuns(basePrevious, sameShaDifferentRuns).status, 'COMPARABLE');
});

test('trends output is deterministic and integrates into offline reports', () => {
  const previous = makeRun({ runKey: 'previous', source: 'a' });
  const current = makeRun({ runKey: 'current', source: 'b', values: { 'v1:function-1': { cognitiveComplexity: 12, functionLength: 20 } } });
  const first = compareMaintainabilityRuns(previous, current);
  const second = compareMaintainabilityRuns(previous, current);
  assert.deepEqual(first, second);
  assert.match(renderMaintainabilityTrendsMarkdown(first), /Maintainability trends/);
  const reportRun = { ...current, functionMeasurements: current.functionMeasurements, maintainabilityCoverage: current.maintainabilityCoverage };
  const structured = buildStructuredReport(reportRun, { maintainabilityTrends: first });
  assert.equal(structured.maintainabilityTrends.currentRunId, current.runId);
  assert.match(renderMarkdown(reportRun, { maintainabilityTrends: first }), /Maintainability trends/);
});

test('trends CLI reads two runs, never scans, and supports JSON and Markdown output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-trends-cli-'));
  try {
    const previous = makeRun({ runKey: 'previous', source: 'c' });
    const current = makeRun({ runKey: 'current', source: 'd', values: { 'v1:function-1': { cognitiveComplexity: 12 } } });
    fs.writeFileSync(path.join(root, 'previous.json'), JSON.stringify(previous), 'utf8');
    fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify(current), 'utf8');
    const cli = path.resolve(__dirname, '..', 'bin', 'quality-audit-kit.js');
    const json = spawnSync(process.execPath, [cli, 'trends', 'previous.json', 'current.json', '--format', 'json'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).status, 'COMPARABLE');
    const markdown = spawnSync(process.execPath, [cli, 'trends', 'previous.json', 'current.json', '--format', 'markdown', '--output', 'trends.md'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(fs.readFileSync(path.join(root, 'trends.md'), 'utf8'), /Comparable functions/);
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
