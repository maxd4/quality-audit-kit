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
  const result = {
    measurementId: `${runKey}-${functionId}-${metricId}`,
    engine: 'maintainability',
    engineVersion,
    metricId,
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
  if (metricVersion !== null) result.metricVersion = metricVersion;
  return result;
}

function makeRun({ runKey, runId = `${runKey}-run-001`, source = runKey, values = {}, functions, eligibleFiles, engineStatus = 'MEASURED', coverageStatus = 'MEASURED', inputScope = 'COMMITTED_SNAPSHOT', engineVersion = '1.1.0', metricVersion = '1' } = {}) {
  const functionEntries = functions === undefined ? [{ functionId: 'v1:function-1', functionName: 'processData', pathName: 'src/data.js' }] : functions;
  const functionMeasurements = functionEntries.flatMap((entry) => Object.entries(values[entry.functionId] || values[entry.functionName] || {
    cognitiveComplexity: 10,
    cyclomaticComplexity: 3,
    functionLength: 20,
    decisionCount: 2,
    maxDecisionDepth: 1,
    nestedDecisionCount: 0,
    maxSubtreeDecisionCount: 1,
  }).map(([metricId, value]) => measurement({ runKey, source, ...entry, metricId, value, metricVersion, engineVersion })));
  const inventoryPaths = eligibleFiles || [...new Set(functionEntries.map((entry) => entry.pathName))];
  const functionsByPath = new Map(inventoryPaths.map((pathName) => [pathName, new Set(functionEntries.filter((entry) => entry.pathName === pathName).map((entry) => entry.functionId)).size]));
  return {
    schemaVersion: '0.1-draft',
    runId,
    repository: { name: 'synthetic-repository', contextCommitSha: revision(source).sha },
    inputScope,
    reproducible: true,
    engines: [{ name: 'maintainability', version: engineVersion, measurementStatus: engineStatus, gateOutcome: engineStatus === 'MEASURED' ? 'INFORMATIVE' : 'NOT_EVALUATED', gateRelevant: false, sourceRevision: revision(source), scope: 'function' }],
    findings: [],
    functionMeasurements,
    maintainabilityCoverage: { schemaVersion: '0.1-draft', status: coverageStatus, eligibleFiles: inventoryPaths.map((pathName) => ({ path: pathName, language: pathName.endsWith('.ts') ? 'typescript' : 'javascript', status: 'MEASURED', functionsMeasured: functionsByPath.get(pathName) })), measuredFiles: inventoryPaths, excludedFiles: [], unsupportedFiles: [], errorFiles: [], functionsMeasured: new Set(functionEntries.map((entry) => entry.functionId)).size, engines: [{ name: 'maintainability', version: engineVersion, parser: 'qak-lexical-ast@1.0.0' }] },
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

test('rejects one function id carrying multiple structural identities', () => {
  const previous = makeRun({ runKey: 'identity-previous', source: 'e', functions: [
    { functionId: 'v1:collision-id', functionName: 'firstName', pathName: 'src/one.js' },
    { functionId: 'v1:collision-id', functionName: 'secondName', pathName: 'src/two.js' },
  ] });
  const current = makeRun({ runKey: 'identity-current', source: 'f' });
  const result = compareMaintainabilityRuns(previous, current);
  assert.equal(result.status, 'COMPARABLE');
  assert.equal(result.functions.length, 0);
  assert.equal(result.nonComparableFunctions.some((entry) => entry.reason === 'FUNCTION_ID_COLLISION'), true);
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

test('requires complete coverage, scope, engine versions and metric definitions before comparing', () => {
  const previous = makeRun({ runKey: 'contract-previous', source: 'e' });
  const current = makeRun({ runKey: 'contract-current', source: 'f', values: { 'v1:function-1': { cognitiveComplexity: 12 } } });

  const missingCoverage = { ...current };
  delete missingCoverage.maintainabilityCoverage;
  const missingCoverageResult = compareMaintainabilityRuns(previous, missingCoverage);
  assert.equal(missingCoverageResult.status, 'NOT_COMPARABLE');
  assert.equal(missingCoverageResult.contract.checks.current.coverage, false);
  assert.match(missingCoverageResult.contract.reasons.join(' '), /no maintainabilityCoverage inventory/i);

  const contradictoryCoverage = makeRun({ runKey: 'coverage-contradiction', source: 'f' });
  contradictoryCoverage.maintainabilityCoverage.functionsMeasured = 0;
  const contradictoryCoverageResult = compareMaintainabilityRuns(previous, contradictoryCoverage);
  assert.equal(contradictoryCoverageResult.status, 'NOT_COMPARABLE');
  assert.match(contradictoryCoverageResult.contract.reasons.join(' '), /functionsMeasured/i);

  const missingScope = makeRun({ runKey: 'missing-scope', source: 'f' });
  delete missingScope.inputScope;
  const missingScopeResult = compareMaintainabilityRuns(previous, missingScope);
  assert.equal(missingScopeResult.status, 'NOT_COMPARABLE');
  assert.equal(missingScopeResult.contract.checks.current.scope, false);
  assert.match(missingScopeResult.contract.reasons.join(' '), /inputScope/i);

  const missingMetricPrevious = makeRun({ runKey: 'missing-metric-previous', source: 'e', metricVersion: null });
  const missingMetricVersion = makeRun({ runKey: 'missing-metric-version', source: 'f', metricVersion: null, values: { 'v1:function-1': { cognitiveComplexity: 12 } } });
  const missingMetricVersionResult = compareMaintainabilityRuns(missingMetricPrevious, missingMetricVersion);
  assert.equal(missingMetricVersionResult.status, 'NOT_COMPARABLE');
  assert.equal(missingMetricVersionResult.functions.length, 0);
  assert.match(missingMetricVersionResult.contract.reasons.join(' '), /versioned metric definition/i);

  const contradictoryEngine = makeRun({ runKey: 'contradictory-engine', source: 'f' });
  contradictoryEngine.engines[0].version = '9.0.0';
  const contradictoryEngineResult = compareMaintainabilityRuns(previous, contradictoryEngine);
  assert.equal(contradictoryEngineResult.status, 'NOT_COMPARABLE');
  assert.match(contradictoryEngineResult.contract.reasons.join(' '), /engine version/i);
});

test('keeps a complete measured zero-function inventory comparable', () => {
  const previous = makeRun({ runKey: 'zero-previous', source: 'a', functions: [], eligibleFiles: ['src/constants.js'] });
  const current = makeRun({ runKey: 'zero-current', source: 'b', functions: [], eligibleFiles: ['src/constants.js'] });
  const result = compareMaintainabilityRuns(previous, current);
  assert.equal(result.status, 'COMPARABLE');
  assert.equal(result.contract.checks.previous.coverage, true);
  assert.equal(result.contract.checks.current.metricDefinitions, true);
  assert.deepEqual(result.functions, []);
  assert.equal(result.summary.comparableFunctions, 0);
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
    const previousBefore = fs.readFileSync(path.join(root, 'previous.json'));
    const currentBefore = fs.readFileSync(path.join(root, 'current.json'));
    const cli = path.resolve(__dirname, '..', 'bin', 'quality-audit-kit.js');
    const json = spawnSync(process.execPath, [cli, 'trends', 'previous.json', 'current.json', '--format', 'json'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).status, 'COMPARABLE');
    assert.deepEqual(fs.readFileSync(path.join(root, 'previous.json')), previousBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), currentBefore);
    const markdown = spawnSync(process.execPath, [cli, 'trends', 'previous.json', 'current.json', '--format', 'markdown', '--output', 'trends.md'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(fs.readFileSync(path.join(root, 'trends.md'), 'utf8'), /Comparable functions/);
    const report = spawnSync(process.execPath, [cli, 'report', 'current.json', '--previous-run', 'previous.json', '--format', 'json', '--output', 'report.json'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8')).maintainabilityTrends.status, 'COMPARABLE');
    assert.deepEqual(fs.readFileSync(path.join(root, 'previous.json')), previousBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), currentBefore);
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
