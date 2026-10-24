const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { analyzeRepository } = require('../src/maintainability');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-maintainability-benchmark-'));
const fileCount = Number(process.env.QAK_BENCHMARK_FILES || 100);
const iterations = Math.max(3, Number(process.env.QAK_BENCHMARK_ITERATIONS || 5));
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}
try {
  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(root, `fixture-${String(index).padStart(4, '0')}.js`), `function fixture${index}(value) {\n  if (value > ${index}) return value + 1;\n  return value;\n}\nconst callback${index} = items => items.map(item => item + ${index});\n`);
  }
  const sourceRevision = { status: 'UNKNOWN', sha: null, basis: 'Synthetic benchmark corpus.' };
  const baselineSamples = [];
  const structuralSamples = [];
  let baseline;
  let result;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let started = performance.now();
    baseline = analyzeRepository(root, { sourceRevision, structural: false });
    baselineSamples.push(performance.now() - started);
    started = performance.now();
    result = analyzeRepository(root, { sourceRevision });
    structuralSamples.push(performance.now() - started);
  }
  const baselineElapsedMs = Math.round(median(baselineSamples) * 100) / 100;
  const elapsedMs = Math.round(median(structuralSamples) * 100) / 100;
  const structuralOverheadMs = Math.round((elapsedMs - baselineElapsedMs) * 100) / 100;
  const output = {
    status: result.status,
    corpus: 'synthetic',
    filesCreated: fileCount,
    iterations,
    eligibleFiles: result.coverage.eligibleFiles.length,
    measuredFiles: result.coverage.measuredFiles.length,
    functionsMeasured: result.coverage.functionsMeasured,
    metricMeasurements: result.measurements.length,
    baselineMetricMeasurements: baseline.measurements.length,
    baselineElapsedMs,
    elapsedMs,
    structuralOverheadMs,
    structuralOverheadPercent: baselineElapsedMs ? Math.round((structuralOverheadMs / baselineElapsedMs) * 10000) / 100 : null,
    filesPerSecond: elapsedMs ? Math.round((result.coverage.measuredFiles.length / (elapsedMs / 1000)) * 100) / 100 : null,
    parser: result.coverage.engines,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
