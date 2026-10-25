const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  const orderedIssues = [
    { key: 'ISSUE-1', rule: 'js:Rule', severity: 'MAJOR', component: 'demo-project:src/a.js', line: 3, message: 'First issue' },
    { key: 'ISSUE-2', rule: 'js:Rule', severity: 'MINOR', component: 'demo-project:src/b.js', line: 4, message: 'Second issue' },
    { key: 'ISSUE-3', rule: 'js:Rule', severity: 'INFO', component: 'demo-project:src/c.js', message: 'Third issue' },
  ];
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
      const pageSize = Number(parsed.searchParams.get('ps'));
      const offset = (page - 1) * pageSize;
      return response(JSON.stringify({
        paging: { total: orderedIssues.length, pageIndex: page, pageSize },
        issues: orderedIssues.slice(offset, offset + pageSize),
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
  assert.deepEqual(Array.from(exported.issues.pages.flatMap((item) => item.response.issues).map((issue) => issue.key)), ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);
  assert.deepEqual(Array.from(exported.issues.pages.map((item) => item.request.ps)), [2, 2]);
  assert.equal(exported.analysis.selected.revision, 'b'.repeat(40));
  assert.equal(calls.filter((call) => call.parsed.pathname === '/api/issues/search').length, 2);
  assert.equal(/document\.cookie|localStorage|sessionStorage/.test(fs.readFileSync(SCRIPT, 'utf8')), false);
  assert.doesNotMatch(JSON.stringify(exported), /secret|authorization/i);
  const repeated = await exporter.collect({ maxResults: 3, pageSize: 2 }, { location, fetch, now: () => '2026-10-24T12:00:00.000Z' });
  assert.deepEqual(repeated, exported);
});

test('browser exporter rejects short intermediate pages without rejecting naturally short final pages', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  const collectPages = async (pages, total, options = {}) => {
    const requested = [];
    const pageSize = options.pageSize || 2;
    const exported = await exporter.collect({ maxResults: options.maxResults || total, pageSize }, {
      location,
      fetch: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/server/version') return response('10.6.0.92116');
        if (parsed.pathname === '/api/issues/search') {
          const page = Number(parsed.searchParams.get('p'));
          const ps = Number(parsed.searchParams.get('ps'));
          requested.push({ page, ps });
          return response(JSON.stringify({ paging: { total, pageIndex: page, pageSize: ps }, issues: pages[page - 1] || [] }));
        }
        if (parsed.pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [] }));
        throw new Error(`unexpected endpoint ${parsed.pathname}`);
      },
      now: () => '2026-10-24T12:00:00.000Z',
    });
    return { exported, requested };
  };

  const threeComplete = await collectPages([[{ key: 'A' }, { key: 'B' }], [{ key: 'C' }]], 3);
  assert.equal(threeComplete.exported.status, 'MEASURED');
  assert.equal(threeComplete.exported.issues.pagination.status, 'COMPLETE');
  assert.deepEqual(Array.from(threeComplete.exported.issues.pages.at(-1).response.issues, (issue) => issue.key), ['C']);
  assert.deepEqual(threeComplete.requested.map((request) => request.ps), [2, 2]);

  const threeShort = await collectPages([[{ key: 'A' }], [{ key: 'B' }, { key: 'C' }]], 3);
  assert.equal(threeShort.exported.status, 'PARTIAL');
  assert.equal(threeShort.exported.issues.pagination.status, 'PARTIAL');
  assert.ok(threeShort.exported.diagnostics.some((item) => item.code === 'PAGINATION_PAGE_SHORT_BEFORE_FINAL'));
  assert.deepEqual(Array.from(threeShort.exported.issues.pages.flatMap((page) => page.response.issues), (issue) => issue.key), ['A', 'B', 'C']);

  const elevenComplete = await collectPages([
    Array.from({ length: 5 }, (_, index) => ({ key: `A${index}` })),
    Array.from({ length: 5 }, (_, index) => ({ key: `B${index}` })),
    [{ key: 'C0' }],
  ], 11, { pageSize: 5 });
  assert.equal(elevenComplete.exported.status, 'MEASURED');
  assert.equal(elevenComplete.exported.issues.pagination.status, 'COMPLETE');
  assert.deepEqual(elevenComplete.requested.map((request) => request.ps), [5, 5, 5]);

  const elevenShort = await collectPages([
    Array.from({ length: 4 }, (_, index) => ({ key: `A${index}` })),
    Array.from({ length: 5 }, (_, index) => ({ key: `B${index}` })),
    [{ key: 'C0' }, { key: 'C1' }],
  ], 11, { pageSize: 5 });
  assert.equal(elevenShort.exported.status, 'PARTIAL');
  assert.equal(elevenShort.exported.issues.pagination.status, 'PARTIAL');
  assert.ok(elevenShort.exported.diagnostics.some((item) => item.code === 'PAGINATION_PAGE_SHORT_BEFORE_FINAL'));
  assert.equal(elevenShort.exported.issues.pagination.exportedCount, 11);

  const emptyIntermediate = await collectPages([[{ key: 'A' }, { key: 'B' }], [], [{ key: 'C' }]], 5);
  assert.equal(emptyIntermediate.exported.status, 'PARTIAL');
  assert.equal(emptyIntermediate.exported.issues.pagination.status, 'PARTIAL');
  assert.ok(emptyIntermediate.exported.diagnostics.some((item) => item.code === 'PAGINATION_PAGE_SHORT_BEFORE_FINAL'));

  const fixture = writeBrowserPayload(threeShort.exported);
  try {
    const imported = importSonarExport(fixture.repository, fixture.filePath);
    assert.equal(imported.status, 'PARTIAL');
    assert.ok(imported.diagnostics.some((item) => item.code === 'EXPORT_PAGE_SHORT_BEFORE_FINAL'));
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('browser exporter keeps API page size stable while bounding only stored issues', async () => {
  const exporter = loadExporter();
  const location = { origin: 'https://sonar.example.invalid', href: 'https://sonar.example.invalid/project/overview?id=demo-project' };
  const ordered = Array.from({ length: 11 }, (_, index) => ({ key: `ISSUE-${index + 1}` }));
  const collectOrdered = async (maxResults, pageSize, items = ordered) => {
    const requested = [];
    const exported = await exporter.collect({ maxResults, pageSize }, {
      location,
      fetch: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/server/version') return response('10.6.0.92116');
        if (parsed.pathname === '/api/issues/search') {
          const page = Number(parsed.searchParams.get('p'));
          const ps = Number(parsed.searchParams.get('ps'));
          requested.push({ page, ps });
          const start = (page - 1) * ps;
          return response(JSON.stringify({ paging: { total: items.length, pageIndex: page, pageSize: ps }, issues: items.slice(start, start + ps) }));
        }
        if (parsed.pathname === '/api/project_analyses/search') return response(JSON.stringify({ analyses: [] }));
        throw new Error(`unexpected endpoint ${parsed.pathname}`);
      },
      now: () => '2026-10-24T12:00:00.000Z',
    });
    return { exported, requested };
  };

  const complete = await collectOrdered(11, 5);
  assert.equal(complete.exported.status, 'MEASURED');
  assert.deepEqual(Array.from(complete.exported.issues.pages.flatMap((page) => page.response.issues).map((issue) => issue.key)), ordered.map((issue) => issue.key));
  assert.deepEqual(complete.requested.map((request) => request.ps), [5, 5, 5]);
  assert.equal(complete.exported.issues.pages.at(-1).response.issues.length, 1);

  const limited = await collectOrdered(7, 5);
  assert.equal(limited.exported.status, 'PARTIAL');
  assert.equal(limited.exported.issues.pagination.exportedCount, 7);
  assert.deepEqual(Array.from(limited.exported.issues.pages.flatMap((page) => page.response.issues).map((issue) => issue.key)), ordered.slice(0, 7).map((issue) => issue.key));
  assert.deepEqual(limited.requested.map((request) => request.ps), [5, 5]);
  assert.ok(limited.exported.diagnostics.some((item) => item.code === 'RESULT_LIMIT_REACHED'));
  assert.ok(limited.exported.diagnostics.some((item) => item.code === 'RESULT_LIMIT_TRUNCATED_PAGE'));

  const zero = await collectOrdered(7, 5, []);
  assert.equal(zero.exported.status, 'MEASURED');
  assert.equal(zero.exported.issues.pagination.exportedCount, 0);
  assert.equal(zero.requested.length, 1);

  const small = await collectOrdered(7, 5, ordered.slice(0, 3));
  assert.equal(small.exported.status, 'MEASURED');
  assert.deepEqual(small.requested.map((request) => request.ps), [5]);
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

  const undersized = await collectWith({ paging: { total: 1, pageIndex: 1, pageSize: 1 }, issues: [{ key: 'ISSUE-1' }] }, { maxResults: 2, pageSize: 2 });
  assert.equal(undersized.status, 'PARTIAL');
  assert.ok(undersized.diagnostics.some((item) => item.code === 'PAGINATION_PAGE_SIZE_MISMATCH'));

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

test('browser export importer requires a valid exportedCount and preserves findings and failure status', () => {
  const issueA = { key: 'ISSUE-A', component: 'demo-project:src/a.js', rule: 'js:Rule', message: 'A' };
  const issueB = { key: 'ISSUE-B', component: 'demo-project:src/b.js', rule: 'js:Rule', message: 'B' };
  const issueC = { key: 'ISSUE-C', component: 'demo-project:src/c.js', rule: 'js:Rule', message: 'C' };
  const pages = [issuePage(1, 2, 3, [issueA, issueB], 2), issuePage(2, 2, 3, [issueC], 2)];
  const cases = [
    { name: 'absent', code: 'EXPORT_COUNT_UNAVAILABLE', change: (payload) => { delete payload.issues.pagination.exportedCount; } },
    { name: 'null', code: 'EXPORT_COUNT_INVALID', value: null },
    { name: 'string', code: 'EXPORT_COUNT_INVALID', value: '3' },
    { name: 'negative', code: 'EXPORT_COUNT_NEGATIVE', value: -1 },
    { name: 'contradictory', code: 'EXPORT_COUNT_MISMATCH', value: 2 },
    { name: 'valid', value: 3, expectedStatus: 'MEASURED' },
  ];
  const fixtures = [];
  try {
    for (const testCase of cases) {
      const payload = browserPayload({ pages, reportedTotal: 3, pageSize: 2 });
      if (testCase.change) testCase.change(payload);
      else payload.issues.pagination.exportedCount = testCase.value;
      const fixture = writeBrowserPayload(payload);
      fixtures.push(fixture);
      const imported = importSonarExport(fixture.repository, fixture.filePath);
      assert.equal(imported.status, testCase.expectedStatus || 'PARTIAL', testCase.name);
      assert.equal(imported.findings.length, 3, testCase.name);
      assert.deepEqual(imported.findings.map((finding) => finding.rawReference), [
        'sonarqube://issues/ISSUE-A',
        'sonarqube://issues/ISSUE-B',
        'sonarqube://issues/ISSUE-C',
      ], testCase.name);
      if (testCase.code) assert.ok(imported.diagnostics.some((item) => item.code === testCase.code), testCase.name);
      assert.equal(imported.diagnostics.some((item) => /token|secret/i.test(String(item.message))), false, testCase.name);
    }

    const failurePayload = browserPayload({ pages, reportedTotal: 3, pageSize: 2, status: 'FAILURE' });
    const failure = writeBrowserPayload(failurePayload);
    fixtures.push(failure);
    assert.equal(importSonarExport(failure.repository, failure.filePath).status, 'FAILURE');
  } finally {
    for (const fixture of fixtures) fs.rmSync(fixture.repository, { recursive: true, force: true });
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

test('browser export importer requires stable page sizes and continuous page coverage', () => {
  const issueA = { key: 'ISSUE-A', component: 'demo-project:src/a.js', message: 'A' };
  const issueB = { key: 'ISSUE-B', component: 'demo-project:src/b.js', message: 'B' };
  const issueC = { key: 'ISSUE-C', component: 'demo-project:src/c.js', message: 'C' };
  const valid = writeBrowserPayload(browserPayload({
    pages: [issuePage(1, 2, 3, [issueA, issueB], 2), issuePage(2, 2, 3, [issueC], 2)],
    reportedTotal: 3,
    pageSize: 2,
  }));
  const variable = writeBrowserPayload(browserPayload({
    pages: [issuePage(1, 2, 3, [issueA, issueB], 2), issuePage(2, 1, 3, [issueC], 1)],
    reportedTotal: 3,
    pageSize: 2,
  }));
  const shortIntermediate = writeBrowserPayload(browserPayload({
    pages: [issuePage(1, 2, 3, [issueA], 2), issuePage(2, 2, 3, [issueB, issueC], 2)],
    reportedTotal: 3,
    pageSize: 2,
  }));
  const missing = writeBrowserPayload(browserPayload({
    pages: [issuePage(1, 2, 3, [issueA, issueB], 2), issuePage(3, 2, 3, [issueC], 2)],
    reportedTotal: 3,
    pageSize: 2,
  }));
  try {
    const validImported = importSonarExport(valid.repository, valid.filePath);
    assert.equal(validImported.status, 'MEASURED');
    assert.equal(validImported.findings.length, 3);

    const variableImported = importSonarExport(variable.repository, variable.filePath);
    assert.notEqual(variableImported.status, 'MEASURED');
    assert.ok(variableImported.diagnostics.some((item) => item.code === 'EXPORT_REQUEST_PAGE_SIZE_CHANGED'));

    const shortImported = importSonarExport(shortIntermediate.repository, shortIntermediate.filePath);
    assert.notEqual(shortImported.status, 'MEASURED');
    assert.ok(shortImported.diagnostics.some((item) => item.code === 'EXPORT_PAGE_SHORT_BEFORE_FINAL'));

    const missingImported = importSonarExport(missing.repository, missing.filePath);
    assert.notEqual(missingImported.status, 'MEASURED');
    assert.ok(missingImported.diagnostics.some((item) => item.code === 'EXPORT_PAGINATION_PAGE_MISMATCH'));
  } finally {
    for (const item of [valid, variable, shortIntermediate, missing]) fs.rmSync(item.repository, { recursive: true, force: true });
  }
});

test('CLI imports a browser export and renders a coherent offline report', () => {
  const issue = { key: 'ISSUE-CLI', component: 'demo-project:src/a.js', rule: 'js:Rule', severity: 'MAJOR', line: 3, message: 'CLI issue' };
  const fixture = writeBrowserPayload(browserPayload({
    pages: [issuePage(1, 2, 1, [issue], 2)],
    reportedTotal: 1,
    pageSize: 2,
  }));
  const runPath = path.join(fixture.repository, 'sonar-run.json');
  const reportPath = path.join(fixture.repository, 'sonar-report.json');
  try {
    const imported = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'quality-audit-kit.js'), 'import', 'sonar-export', fixture.filePath, '--repository', fixture.repository, '--output', runPath], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    assert.equal(run.engines[0].measurementStatus, 'MEASURED');
    assert.equal(run.findings[0].provenance.kind, 'REPORT');
    assert.equal('measurementStatus' in run.findings[0].provenance, false);

    const reported = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'quality-audit-kit.js'), 'report', runPath, '--format', 'json', '--output', reportPath], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(reported.status, 0, reported.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.measurements[0].measurementStatus, 'MEASURED');
    assert.equal(report.findings.unclassified.length, 1);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
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
