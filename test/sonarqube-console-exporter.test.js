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

function issuePage(pageIndex, pageSize, total, issues, requestSize = pageSize) {
  return {
    request: { p: pageIndex, ps: requestSize },
    response: { paging: { total, pageIndex, pageSize }, issues },
  };
}

function browserPayload({ pages, reportedTotal, requestedLimit = 1000, pageSize = 500, status = 'MEASURED', pagination = {}, analysis = { analyses: [] } }) {
  return {
    format: 'quality-audit-kit/sonarqube-browser-export',
    formatVersion: 1,
    exportedAt: '2026-10-24T12:00:00.000Z',
    status,
    source: { origin: 'https://sonar.example.invalid', project: 'demo-project', branch: null, pullRequest: null, version: '10.6.0.92116', apiProfile: 'web-api-v2-aware-v1-compatible', compatibility: { status: 'COMPATIBLE' } },
    serverVersion: { endpoint: '/api/server/version', response: '10.6.0.92116' },
    issues: { endpoint: '/api/issues/search', pagination: { requestedLimit, pageSize, reportedTotal, exportedCount: pages.reduce((sum, page) => sum + (Array.isArray(page.response?.issues) ? page.response.issues.length : 0), 0), pageCount: pages.length, status: 'COMPLETE', limitReached: false, ...pagination }, pages },
    analysis: { endpoint: '/api/project_analyses/search', response: analysis, selected: Array.isArray(analysis.analyses) ? analysis.analyses[0] || null : null },
    diagnostics: [],
  };
}

function writeBrowserPayload(payload) {
  const repository = fixtureRepository();
  const filePath = path.join(repository, 'sonarqube-export.json');
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`);
  return { repository, filePath };
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
  const repeated = await exporter.collect({ maxResults: 3, pageSize: 2 }, { location, fetch, now: () => '2026-10-24T12:00:00.000Z' });
  assert.deepEqual(repeated, exported);
});

test('browser exporter makes pagination diagnostics force PARTIAL and preserves only the requested bound', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  const collectWith = async (issueBody, options = { maxResults: 1, pageSize: 1 }) => exporter.collect(options, {
    location,
    fetch: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/server/version') return response('10.6.0.92116');
      if (pathname === '/api/issues/search') return response(JSON.stringify(issueBody));
      if (pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [] }));
      throw new Error(`unexpected endpoint ${pathname}`);
    },
    now: () => '2026-10-24T12:00:00.000Z',
  });

  const oversized = await collectWith({ paging: { total: 2, pageIndex: 1, pageSize: 999 }, issues: [{ key: 'ISSUE-1' }, { key: 'ISSUE-2' }] });
  assert.equal(oversized.status, 'PARTIAL');
  assert.equal(oversized.issues.pagination.status, 'PARTIAL');
  assert.equal(oversized.issues.pagination.exportedCount, 1);
  assert.equal(oversized.issues.pages[0].response.issues.length, 1);
  assert.ok(oversized.diagnostics.some((item) => item.code === 'PAGINATION_PAGE_SIZE_UNEXPECTED'));
  assert.ok(oversized.diagnostics.some((item) => item.code === 'PAGINATION_ISSUES_OVER_REQUEST'));

  const missingSize = await collectWith({ paging: { total: 1, pageIndex: 1 }, issues: [{ key: 'ISSUE-1' }] });
  assert.equal(missingSize.status, 'PARTIAL');
  assert.ok(missingSize.diagnostics.some((item) => item.code === 'PAGINATION_METADATA_UNAVAILABLE'));

  const wrongPage = await collectWith({ paging: { total: 1, pageIndex: 2, pageSize: 1 }, issues: [{ key: 'ISSUE-1' }] });
  assert.equal(wrongPage.status, 'PARTIAL');
  assert.ok(wrongPage.diagnostics.some((item) => item.code === 'PAGINATION_PAGE_MISMATCH'));

  const malformed = await collectWith({ paging: { total: 0, pageIndex: 1, pageSize: 1 }, issues: {} });
  assert.equal(malformed.status, 'PARTIAL');
  assert.ok(malformed.diagnostics.some((item) => item.code === 'MALFORMED_ISSUE_RESPONSE'));
});

test('browser exporter never exceeds the configured or absolute 10000 finding bound', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  const issues = Array.from({ length: 10001 }, (_, index) => ({ key: `ISSUE-${index}` }));
  const exported = await exporter.collect({ maxResults: 10000, pageSize: 500 }, {
    location,
    fetch: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/server/version') return response('10.6.0.92116');
      if (pathname === '/api/issues/search') return response(JSON.stringify({ paging: { total: 10001, pageIndex: 1, pageSize: 500 }, issues }));
      if (pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [] }));
      throw new Error(`unexpected endpoint ${pathname}`);
    },
  });
  assert.equal(exported.status, 'PARTIAL');
  assert.ok(exported.issues.pagination.exportedCount <= 10000);
  assert.equal(exported.issues.pages[0].response.issues.length, 500);
  assert.ok(exported.issues.pages.every((page) => page.response.issues.length <= 500));
  assert.ok(exported.diagnostics.some((item) => item.code === 'PAGINATION_ISSUES_OVER_REQUEST'));
  assert.ok(exported.diagnostics.some((item) => item.code === 'RESULT_LIMIT_REACHED'));
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

test('browser export importer recalculates completeness and rejects empty or contradictory evidence', () => {
  const empty = writeBrowserPayload(browserPayload({ pages: [], reportedTotal: null, pagination: { exportedCount: 0, pageCount: 0 } }));
  const contradictory = writeBrowserPayload(browserPayload({
    pages: [issuePage(1, 2, 1, [{ key: 'ISSUE-1', component: 'demo-project:src/a.js', message: 'Issue' }])],
    reportedTotal: 1,
    pagination: { exportedCount: 0 },
  }));
  const zero = writeBrowserPayload(browserPayload({ pages: [issuePage(1, 500, 0, [])], reportedTotal: 0, pagination: { exportedCount: 0 } }));
  try {
    const emptyImported = importSonarExport(empty.repository, empty.filePath);
    assert.notEqual(emptyImported.status, 'MEASURED');
    assert.ok(emptyImported.diagnostics.some((item) => item.code === 'EXPORT_PAGES_EMPTY'));
    assert.ok(emptyImported.diagnostics.some((item) => item.code === 'EXPORT_TOTAL_UNAVAILABLE'));

    const contradictoryImported = importSonarExport(contradictory.repository, contradictory.filePath);
    assert.notEqual(contradictoryImported.status, 'MEASURED');
    assert.ok(contradictoryImported.diagnostics.some((item) => item.code === 'EXPORT_COUNT_MISMATCH'));
    assert.ok(contradictoryImported.diagnostics.some((item) => item.code === 'EXPORT_COMPLETENESS_CONTRADICTION'));

    const zeroImported = importSonarExport(zero.repository, zero.filePath);
    assert.equal(zeroImported.status, 'MEASURED');
    assert.equal(zeroImported.findings.length, 0);
    assert.equal(zeroImported.engine.measurementStatus, 'MEASURED');
  } finally {
    for (const item of [empty, contradictory, zero]) fs.rmSync(item.repository, { recursive: true, force: true });
  }
});

test('browser export importer refuses missing page metadata, counter drift and never upgrades revisions to VERIFIED', () => {
  const malformed = writeBrowserPayload(browserPayload({
    pages: [{ request: { p: 1, ps: 1 }, response: { paging: { total: 1, pageIndex: 1 }, issues: [{ key: 'ISSUE-1' }] } }],
    reportedTotal: 1,
    pageSize: 1,
    pagination: { exportedCount: 1 },
    analysis: { analyses: [{ revision: 'c'.repeat(40) }] },
  }));
  try {
    const imported = importSonarExport(malformed.repository, malformed.filePath);
    assert.notEqual(imported.status, 'MEASURED');
    assert.ok(imported.diagnostics.some((item) => item.code === 'EXPORT_RESPONSE_PAGE_SIZE_INVALID'));
    assert.equal(imported.sourceRevision.status, 'UNVERIFIED');
    assert.notEqual(imported.sourceRevision.status, 'VERIFIED');
  } finally {
    fs.rmSync(malformed.repository, { recursive: true, force: true });
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
