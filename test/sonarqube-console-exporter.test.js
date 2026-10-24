const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const { importSonarExport } = require('../src/sonar');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'sonarqube-console-exporter.js');

function loadExporter() {
  const context = {
    URL,
    console,
    window: { __QAK_SONAR_EXPORTER_DISABLE_AUTO_START__: true },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), context, { filename: SCRIPT });
  return context.QualityAuditKitSonarExporter;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function fixtureRepository() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-kit-browser-export-'));
}

test('SonarQube browser exporter paginates same-origin simulated responses without auth access', async () => {
  const exporter = loadExporter();
  const calls = [];
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project&branch=main' };
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ parsed, init });
    assert.equal(parsed.origin, location.origin);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.accept, 'application/json');
    assert.equal('authorization' in init.headers, false);
    if (parsed.pathname === '/api/server/version') return response('10.6.0.92116');
    if (parsed.pathname === '/api/issues/search') {
      const page = Number(parsed.searchParams.get('p'));
      return response(JSON.stringify({
        paging: { total: 3, pageIndex: page, pageSize: Number(parsed.searchParams.get('ps')) },
        issues: page === 1
          ? [{ key: 'ISSUE-1', rule: 'js:Rule', severity: 'MAJOR', component: 'demo-project:src/a.js', line: 3, message: 'First issue' }, { key: 'ISSUE-2', rule: 'js:Rule', severity: 'MINOR', component: 'demo-project:src/b.js', line: 4, message: 'Second issue' }]
          : [{ key: 'ISSUE-3', rule: 'js:Rule', severity: 'INFO', component: 'demo-project:src/c.js', message: 'Third issue' }],
      }));
    }
    if (parsed.pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [{ key: 'analysis-1', revision: 'b'.repeat(40), date: '2026-10-24T12:00:00+0000' }] }));
    throw new Error(`unexpected endpoint ${parsed.pathname}`);
  };

  const exported = await exporter.collect({ maxResults: 3, pageSize: 2 }, { location, fetch, now: () => '2026-10-24T12:00:00.000Z' });
  assert.equal(exported.status, 'MEASURED');
  assert.equal(exported.source.project, 'demo-project');
  assert.equal(exported.source.branch, 'main');
  assert.equal(exported.issues.pagination.reportedTotal, 3);
  assert.equal(exported.issues.pagination.exportedCount, 3);
  assert.equal(exported.issues.pagination.pageCount, 2);
  assert.equal(exported.issues.pagination.status, 'COMPLETE');
  assert.equal(exported.analysis.selected.revision, 'b'.repeat(40));
  assert.equal(calls.filter((call) => call.parsed.pathname === '/api/issues/search').length, 2);
  assert.equal(/document\.cookie|localStorage|sessionStorage/.test(fs.readFileSync(SCRIPT, 'utf8')), false);
  assert.doesNotMatch(JSON.stringify(exported), /secret|authorization/i);
});

test('browser export importer preserves partial pagination and reuses the SonarQube normalization contract', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  const fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/server/version') return response('10.6.0.92116');
    if (parsed.pathname === '/api/issues/search') return response(JSON.stringify({ paging: { total: 3, pageIndex: 1, pageSize: 2 }, issues: [{ key: 'ISSUE-1', rule: 'js:Rule', severity: 'MAJOR', component: 'demo-project:src/a.js', line: 3, message: 'First issue' }, { key: 'ISSUE-2', rule: 'js:Rule', severity: 'MINOR', component: 'demo-project:src/b.js', line: 4, message: 'Second issue' }] }));
    if (parsed.pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [] }));
    throw new Error('unexpected endpoint');
  };
  const exported = await exporter.collect({ maxResults: 2, pageSize: 2 }, { location, fetch, now: () => '2026-10-24T12:00:00.000Z' });
  assert.equal(exported.status, 'PARTIAL');
  assert.equal(exported.issues.pagination.limitReached, true);
  assert.ok(exported.diagnostics.some((item) => item.code === 'RESULT_LIMIT_REACHED'));

  const repository = fixtureRepository();
  const filePath = path.join(repository, 'sonarqube-export.json');
  fs.writeFileSync(filePath, `${JSON.stringify(exported)}\n`);
  try {
    const imported = importSonarExport(repository, filePath);
    assert.equal(imported.status, 'PARTIAL');
    assert.equal(imported.engine.measurementStatus, 'PARTIAL');
    assert.equal(imported.engine.metadata.browserExport, true);
    assert.equal(imported.findings.length, 2);
    assert.equal(imported.findings[0].engine, 'sonarqube');
    assert.equal(imported.sourceRevision.status, 'UNKNOWN');
    assert.ok(imported.diagnostics.some((item) => item.code === 'RESULT_LIMIT_REACHED'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('browser exporter records incompatible server versions without requesting findings', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  let issueRequests = 0;
  const exported = await exporter.collect({}, {
    location,
    fetch: async (url) => {
      if (new URL(url).pathname === '/api/server/version') return response('not-a-sonarqube-version');
      issueRequests += 1;
      return response('{}');
    },
  });
  assert.equal(exported.status, 'INCOMPATIBLE');
  assert.equal(exported.source.compatibility.status, 'INCOMPATIBLE');
  assert.equal(issueRequests, 0);
  assert.ok(exported.diagnostics.some((item) => item.code === 'INCOMPATIBLE_VERSION'));
});

test('browser exporter extracts the major version and refuses pre-9 or malformed versions before issue requests', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  const cases = [
    { version: '8.9.10', status: 'INCOMPATIBLE', issueRequests: 0 },
    { version: '7.9.6', status: 'INCOMPATIBLE', issueRequests: 0 },
    { version: '9.9.0', status: 'MEASURED', issueRequests: 1 },
    { version: '10.6.0.92116', status: 'MEASURED', issueRequests: 1 },
    { version: '9.9.0-SNAPSHOT', status: 'MEASURED', issueRequests: 1 },
    { version: 'not-a-version', status: 'INCOMPATIBLE', issueRequests: 0 },
    { version: '', status: 'INCOMPATIBLE', issueRequests: 0 },
  ];
  for (const testCase of cases) {
    const calls = [];
    const exported = await exporter.collect({}, {
      location,
      fetch: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed.pathname);
        if (parsed.pathname === '/api/server/version') return response(testCase.version);
        if (parsed.pathname === '/api/issues/search') return response(JSON.stringify({ paging: { total: 0, pageIndex: 1, pageSize: 500 }, issues: [] }));
        if (parsed.pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [] }));
        throw new Error(`unexpected endpoint ${parsed.pathname}`);
      },
    });
    assert.equal(exported.status, testCase.status, testCase.version || '<empty>');
    assert.equal(calls.filter((pathname) => pathname === '/api/issues/search').length, testCase.issueRequests, testCase.version || '<empty>');
    assert.equal(exported.source.compatibility.status, testCase.status === 'INCOMPATIBLE' ? 'INCOMPATIBLE' : 'COMPATIBLE');
    if (testCase.status === 'INCOMPATIBLE') {
      assert.ok(exported.diagnostics.some((item) => item.code === 'INCOMPATIBLE_VERSION'));
      assert.equal(exported.issues.pagination.pageCount, 0);
    } else {
      assert.equal(exported.source.apiProfile, testCase.version.startsWith('10.') ? 'web-api-v2-aware-v1-compatible' : 'web-api-v1-compatible');
    }
  }
});
