const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { analyzeRepository } = require('../src/maintainability');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qak-maintainability-benchmark-'));
const fileCount = Number(process.env.QAK_BENCHMARK_FILES || 100);
try {
  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(root, `fixture-${String(index).padStart(4, '0')}.js`), `function fixture${index}(value) {\n  if (value > ${index}) return value + 1;\n  return value;\n}\nconst callback${index} = items => items.map(item => item + ${index});\n`);
  }
  const started = performance.now();
  const result = analyzeRepository(root, { sourceRevision: { status: 'UNKNOWN', sha: null, basis: 'Synthetic benchmark corpus.' } });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const output = {
    status: result.status,
    corpus: 'synthetic',
    filesCreated: fileCount,
    eligibleFiles: result.coverage.eligibleFiles.length,
    measuredFiles: result.coverage.measuredFiles.length,
    functionsMeasured: result.coverage.functionsMeasured,
    metricMeasurements: result.measurements.length,
    elapsedMs,
    filesPerSecond: elapsedMs ? Math.round((result.coverage.measuredFiles.length / (elapsedMs / 1000)) * 100) / 100 : null,
    parser: result.coverage.engines,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
