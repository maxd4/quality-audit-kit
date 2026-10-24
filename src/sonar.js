const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { normalizeSonar } = require('./normalize');

const DEFAULT_MAX_RESULTS = 1000;
const MAX_RESULTS_LIMIT = 10000;
const PAGE_SIZE = 500;
const SONAR_BROWSER_EXPORT_FORMAT = 'quality-audit-kit/sonarqube-browser-export';
const SONAR_BROWSER_EXPORT_VERSION = 1;

class SonarHttpError extends Error {
  constructor(status, pathname, message) {
    super(`SonarQube API request failed with HTTP ${status} at ${pathname}: ${message}`);
    this.name = 'SonarHttpError';
    this.status = status;
    this.pathname = pathname;
  }
}

function normalizeUrl(value) {
  if (!value) throw new Error('SonarQube URL is required (--sonar-url or SONAR_URL).');
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error('SonarQube URL must be an absolute http(s) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('SonarQube URL must use http or https.');
  if (parsed.username || parsed.password) throw new Error('SonarQube URL must not contain username or password; use a token environment variable or external token file.');
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function isPathOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function readToken({ root = process.cwd(), tokenEnv, tokenFile, env = process.env }) {
  if (tokenEnv && tokenFile) throw new Error('Choose either --sonar-token-env or --sonar-token-file, not both.');
  const environmentName = tokenEnv || 'SONAR_TOKEN';
  if (tokenFile) {
    let repositoryReal;
    let tokenReal;
    try {
      repositoryReal = fs.realpathSync(path.resolve(root));
      tokenReal = fs.realpathSync(path.resolve(tokenFile));
      if (!isPathOutside(repositoryReal, tokenReal) || !fs.statSync(tokenReal).isFile()) throw new Error('invalid token file boundary');
    } catch (error) {
      if (error?.message === 'invalid token file boundary') throw new Error('Sonar token file must be an existing regular file outside the analyzed repository.');
      throw new Error('Sonar token file could not be resolved safely.');
    }
    const token = fs.readFileSync(tokenReal, 'utf8').trim();
    if (!token) throw new Error('Sonar token file is empty.');
    return { value: token, source: 'file' };
  }
  const token = env[environmentName];
  return token ? { value: String(token), source: `environment:${environmentName}` } : { value: null, source: 'none' };
}

function redactSecrets(value, secrets) {
  if (typeof value === 'string') {
    return secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join('[REDACTED_TOKEN]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, secrets)]));
  return value;
}

function safeDiagnostic(error, fallback) {
  return error instanceof SonarHttpError ? error.message : fallback;
}

function versionProfile(version) {
  const major = Number(String(version || '').split('.')[0]);
  if (!Number.isInteger(major)) return 'unknown-web-api';
  return major >= 10 ? 'web-api-v2-aware-v1-compatible' : major >= 9 ? 'web-api-v1-compatible' : 'legacy-web-api';
}

function defaultRequest({ url, headers, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, { method: 'GET', headers, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body }));
    });
    request.on('timeout', () => request.destroy(new Error('SonarQube API request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function createClient({ url, token, request = defaultRequest, timeoutMs }) {
  const baseUrl = normalizeUrl(url);
  async function get(pathname, params = {}) {
    const parsed = new URL(`${baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') parsed.searchParams.set(key, String(value));
    let response;
    try {
      response = await request({
        url: parsed.toString(),
        pathname,
        query: { ...params },
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        timeoutMs,
      });
    } catch {
      throw new Error('SonarQube API request failed before a response was received.');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      const status = response?.status || 0;
      const message = status === 401 || status === 403 ? 'authentication or permission was insufficient' : 'server returned an unsuccessful response';
      throw new SonarHttpError(status, pathname, message);
    }
    if (pathname === '/api/server/version') return String(response.body || '').trim();
    try { return JSON.parse(response.body || '{}'); } catch { throw new Error(`SonarQube API returned invalid JSON for ${pathname}.`); }
  }
  return { baseUrl, get };
}

async function detectVersion(client) {
  const version = await client.get('/api/server/version');
  if (typeof version === 'string') return version;
  if (typeof version?.version === 'string') return version.version;
  throw new Error('SonarQube version endpoint did not return a version string.');
}

function analysisRevision(analysis) {
  const revision = analysis?.revision;
  if (/^[a-f0-9]{40}$/i.test(String(revision || ''))) return { status: 'UNVERIFIED', sha: String(revision).toLowerCase(), basis: 'SonarQube project analysis revision; this is not the local repository HEAD and is not proof of matching local content.' };
  return { status: 'UNKNOWN', sha: null, basis: 'SonarQube analysis did not expose a demonstrable 40-character revision.' };
}

async function latestAnalysis(client, project, branch, pullRequest) {
  const response = await client.get('/api/project_analyses/search', { project, ...(branch ? { branch } : {}), ...(pullRequest ? { pullRequest } : {}), p: 1, ps: 1 });
  const analysis = Array.isArray(response.analyses) ? response.analyses[0] : null;
  return analysis || null;
}

async function fetchIssues(client, { project, branch, pullRequest, maxResults = DEFAULT_MAX_RESULTS }) {
  const bounded = Number(maxResults);
  if (!Number.isInteger(bounded) || bounded < 1 || bounded > MAX_RESULTS_LIMIT) throw new Error(`--sonar-max-results must be an integer between 1 and ${MAX_RESULTS_LIMIT}.`);
  const findings = [];
  const diagnostics = [];
  let total = null;
  let page = 1;
  try {
    while (findings.length < bounded && (total === null || findings.length < total)) {
      const requestSize = Math.min(PAGE_SIZE, bounded - findings.length);
      const response = await client.get('/api/issues/search', {
        componentKeys: project,
        p: page,
        ps: requestSize,
        ...(branch ? { branch } : {}),
        ...(pullRequest ? { pullRequest } : {}),
      });
      const issues = Array.isArray(response.issues) ? response.issues : [];
      total = Number.isInteger(response.paging?.total) ? response.paging.total : findings.length + issues.length;
      findings.push(...issues);
      if (!issues.length || (total !== null ? findings.length >= total : issues.length < requestSize)) break;
      page += 1;
    }
  } catch (error) {
    if (findings.length) {
      diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'PARTIAL_API_RESPONSE', reference: '/api/issues/search', message: safeDiagnostic(error, 'SonarQube API request failed before a complete page was imported.') });
      return { issues: findings, total, status: 'PARTIAL', diagnostics };
    }
    throw error;
  }
  if (total !== null && total > bounded) {
    diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'RESULT_LIMIT_REACHED', reference: '/api/issues/search', message: `SonarQube reported ${total} results; only the configured limit ${bounded} was imported.` });
    return { issues: findings.slice(0, bounded), total, status: 'PARTIAL', diagnostics };
  }
  return { issues: findings, total, status: 'MEASURED', diagnostics };
}

async function connectSonar(options = {}) {
  const token = readToken(options);
  const client = createClient({ url: options.url, token: token.value, request: options.request, timeoutMs: options.timeoutMs });
  const version = await detectVersion(client);
  return { status: 'CONNECTED', url: client.baseUrl, project: options.project || null, version, apiProfile: versionProfile(version), authentication: token.source === 'none' ? 'none' : 'bearer-token', tokenSource: token.source };
}

async function importSonar(root, options = {}) {
  if (!options.project) throw new Error('SonarQube project key is required (--sonar-project or SONAR_PROJECT).');
  const token = readToken({ ...options, root });
  const client = createClient({ url: options.url || process.env.SONAR_URL, token: token.value, request: options.request, timeoutMs: options.timeoutMs });
  const version = await detectVersion(client);
  const branch = options.branch || null;
  const pullRequest = options.pullRequest || null;
  if (branch && pullRequest) throw new Error('SonarQube branch and pull request selectors are mutually exclusive.');
  const issueResult = await fetchIssues(client, { project: options.project, branch, pullRequest, maxResults: options.maxResults });
  let analysis = null;
  const analysisDiagnostics = [];
  try {
    analysis = await latestAnalysis(client, options.project, branch, pullRequest);
  } catch (error) {
    analysisDiagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'ANALYSIS_METADATA_UNAVAILABLE', reference: '/api/project_analyses/search', message: safeDiagnostic(error, 'SonarQube analysis metadata could not be imported completely.') });
  }
  const sourceRevision = analysisRevision(analysis);
  if (options.revision && sourceRevision.sha && String(options.revision).toLowerCase() !== sourceRevision.sha) throw new Error('The requested SonarQube revision does not match the latest analysis revision; refusing to attribute findings to another revision.');
  const status = issueResult.status === 'MEASURED' && analysisDiagnostics.length ? 'PARTIAL' : issueResult.status;
  const normalized = normalizeSonar(root, issueResult.issues, { kind: 'REPORT', reference: `sonarqube://${options.project}`, sourceRevision, measurementStatus: status });
  return redactSecrets({
    version,
    apiProfile: versionProfile(version),
    project: options.project,
    branch,
    pullRequest,
    analysis,
    sourceRevision,
    status,
    findings: normalized.findings,
    diagnostics: [...issueResult.diagnostics, ...analysisDiagnostics, ...normalized.diagnostics],
    engine: {
      name: 'sonarqube',
      version,
      projectKey: options.project,
      ...(branch ? { branch } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      measurementStatus: status,
      gateOutcome: status === 'MEASURED' ? 'INFORMATIVE' : 'NOT_EVALUATED',
      sourceRevision,
      scope: branch ? `sonarqube:${options.project}@branch:${branch}` : `sonarqube:${options.project}`,
      metadata: {
        ...(analysis?.key ? { analysisKey: String(analysis.key) } : {}),
        ...(analysis?.date ? { analysisDate: String(analysis.date) } : {}),
        importedIssueCount: issueResult.issues.length,
        reportedIssueCount: issueResult.total,
      },
      diagnostic: issueResult.diagnostics.length + analysisDiagnostics.length ? `${issueResult.diagnostics.length + analysisDiagnostics.length} SonarQube diagnostic(s) were retained; the imported measure is not complete.` : undefined,
    },
  }, [token.value]);
}

function readSonarBrowserExport(root, filePath) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    throw new Error('SonarQube browser export must be a readable JSON file.');
  }
  if (!payload || typeof payload !== 'object' || payload.format !== SONAR_BROWSER_EXPORT_FORMAT || payload.formatVersion !== SONAR_BROWSER_EXPORT_VERSION) {
    throw new Error(`Unsupported SonarQube browser export format; expected ${SONAR_BROWSER_EXPORT_FORMAT} v${SONAR_BROWSER_EXPORT_VERSION}.`);
  }
  const source = payload.source;
  if (!source || typeof source.project !== 'string' || !source.project.trim() || typeof source.version !== 'string' || !source.version.trim()) {
    throw new Error('SonarQube browser export is missing source project or server version metadata.');
  }
  const pages = payload.issues?.pages;
  if (!Array.isArray(pages)) throw new Error('SonarQube browser export is missing paginated issue responses.');
  return { payload, source, pages };
}

function importSonarExport(root, filePath) {
  const { payload, source, pages } = readSonarBrowserExport(root, filePath);
  const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics.map((item) => ({ ...item })) : [];
  const issues = [];
  const seenIssueKeys = new Set();
  let reportedTotal = Number.isInteger(payload.issues?.pagination?.reportedTotal) ? payload.issues.pagination.reportedTotal : null;
  let status = payload.status === 'MEASURED' ? 'MEASURED' : payload.status === 'PARTIAL' ? 'PARTIAL' : 'FAILURE';

  if (source.compatibility?.status !== 'COMPATIBLE') {
    status = 'FAILURE';
    diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'INCOMPATIBLE_EXPORT_VERSION', reference: '/api/server/version', message: 'The browser export declared an incompatible or unverified SonarQube server version; the findings are not a clean measurement.' });
  }

  let expectedPage = 1;
  for (const [index, page] of pages.entries()) {
    const response = page?.response;
    const pageIndex = response?.paging?.pageIndex;
    const pageIssues = response?.issues;
    if (!Number.isInteger(pageIndex) || pageIndex !== expectedPage || !Array.isArray(pageIssues)) {
      status = status === 'FAILURE' ? status : 'PARTIAL';
      diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'EXPORT_PAGINATION_INCOMPLETE', reference: `/api/issues/search?page=${index + 1}`, message: 'The browser export contains a missing, reordered or malformed issue page; completeness is not established.' });
      continue;
    }
    if (Number.isInteger(response.paging.total)) {
      if (reportedTotal === null) reportedTotal = response.paging.total;
      if (response.paging.total !== reportedTotal) {
        status = status === 'FAILURE' ? status : 'PARTIAL';
        diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'PAGINATION_TOTAL_CHANGED', reference: `/api/issues/search?p=${pageIndex}`, message: 'SonarQube reported different totals across exported pages; completeness is not established.' });
      }
    }
    expectedPage += 1;
    for (const issue of pageIssues) {
      const key = issue?.key === undefined ? null : String(issue.key);
      if (key && seenIssueKeys.has(key)) {
        status = status === 'FAILURE' ? status : 'PARTIAL';
        diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'DUPLICATE_ISSUE', reference: `sonarqube://issues/${encodeURIComponent(key)}`, message: 'The browser export repeated a SonarQube issue across pages; the duplicate was retained for auditability.' });
      }
      if (key) seenIssueKeys.add(key);
      issues.push(issue);
    }
  }

  const requestedLimit = Number(payload.issues?.pagination?.requestedLimit);
  if (Number.isInteger(reportedTotal) && Number.isInteger(requestedLimit) && reportedTotal > requestedLimit) {
    status = status === 'FAILURE' ? status : 'PARTIAL';
    diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'RESULT_LIMIT_REACHED', reference: '/api/issues/search', message: `SonarQube reported ${reportedTotal} results; the browser export limit ${requestedLimit} was reached.` });
  }
  if (Number.isInteger(reportedTotal) && issues.length < reportedTotal) {
    status = status === 'FAILURE' ? status : 'PARTIAL';
    diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'EXPORT_PAGINATION_INCOMPLETE', reference: '/api/issues/search', message: `The browser export contains ${issues.length} issues for a reported total of ${reportedTotal}; absence cannot be inferred.` });
  }
  if (payload.issues?.pagination?.status !== 'COMPLETE' && status === 'MEASURED') status = 'PARTIAL';

  const analysisResponse = payload.analysis?.response;
  const analysis = Array.isArray(analysisResponse?.analyses) ? analysisResponse.analyses[0] || null : null;
  const sourceRevision = analysisRevision(analysis);
  const reference = `sonarqube://${encodeURIComponent(source.project)}/browser-export`;
  const normalized = normalizeSonar(root, issues, { kind: 'EXPORT', reference, sourceRevision, measurementStatus: status });
  const allDiagnostics = [...diagnostics, ...normalized.diagnostics];
  const branch = source.branch || null;
  const pullRequest = source.pullRequest || null;
  return redactSecrets({
    version: source.version,
    apiProfile: source.apiProfile || versionProfile(source.version),
    project: source.project,
    branch,
    pullRequest,
    analysis,
    sourceRevision,
    status,
    findings: normalized.findings,
    diagnostics: allDiagnostics,
    engine: {
      name: 'sonarqube',
      version: source.version,
      projectKey: source.project,
      ...(branch ? { branch } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      measurementStatus: status,
      gateOutcome: status === 'MEASURED' ? 'INFORMATIVE' : 'NOT_EVALUATED',
      sourceRevision,
      scope: branch ? `sonarqube:${source.project}@branch:${branch}` : pullRequest ? `sonarqube:${source.project}@pull-request:${pullRequest}` : `sonarqube:${source.project}`,
      metadata: {
        browserExport: true,
        browserExportFormat: SONAR_BROWSER_EXPORT_FORMAT,
        browserExportVersion: SONAR_BROWSER_EXPORT_VERSION,
        ...(payload.exportedAt ? { exportedAt: String(payload.exportedAt) } : {}),
        importedIssueCount: issues.length,
        reportedIssueCount: reportedTotal,
        pageCount: pages.length,
        paginationStatus: payload.issues?.pagination?.status || 'UNKNOWN',
        ...(payload.serverVersion?.endpoint ? { serverVersionEndpoint: String(payload.serverVersion.endpoint) } : {}),
      },
      diagnostic: allDiagnostics.length ? `${allDiagnostics.length} SonarQube diagnostic(s) were retained; the imported measure is not necessarily complete.` : undefined,
    },
  }, []);
}

module.exports = {
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_LIMIT,
  SONAR_BROWSER_EXPORT_FORMAT,
  SONAR_BROWSER_EXPORT_VERSION,
  SonarHttpError,
  analysisRevision,
  connectSonar,
  createClient,
  fetchIssues,
  importSonar,
  importSonarExport,
  normalizeUrl,
  readSonarBrowserExport,
  readToken,
  versionProfile,
};
