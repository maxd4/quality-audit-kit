const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { normalizeSonar } = require('./normalize');

const DEFAULT_MAX_RESULTS = 1000;
const MAX_RESULTS_LIMIT = 10000;
const PAGE_SIZE = 500;

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
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function readToken({ root = process.cwd(), tokenEnv, tokenFile, env = process.env }) {
  if (tokenEnv && tokenFile) throw new Error('Choose either --sonar-token-env or --sonar-token-file, not both.');
  const environmentName = tokenEnv || 'SONAR_TOKEN';
  if (tokenFile) {
    const absolute = path.resolve(tokenFile);
    const relative = path.relative(root, absolute);
    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('Sonar token file must be outside the analyzed repository.');
    const token = fs.readFileSync(absolute, 'utf8').trim();
    if (!token) throw new Error('Sonar token file is empty.');
    return { value: token, source: 'file' };
  }
  const token = env[environmentName];
  return token ? { value: String(token), source: `environment:${environmentName}` } : { value: null, source: 'none' };
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
    const response = await request({
      url: parsed.toString(),
      pathname,
      query: { ...params },
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      timeoutMs,
    });
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
      diagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'PARTIAL_API_RESPONSE', reference: '/api/issues/search', message: error.message });
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
    analysisDiagnostics.push({ kind: 'SONAR_DIAGNOSTIC', code: 'ANALYSIS_METADATA_UNAVAILABLE', reference: '/api/project_analyses/search', message: error.message });
  }
  const sourceRevision = analysisRevision(analysis);
  if (options.revision && sourceRevision.sha && String(options.revision).toLowerCase() !== sourceRevision.sha) throw new Error('The requested SonarQube revision does not match the latest analysis revision; refusing to attribute findings to another revision.');
  const status = issueResult.status === 'MEASURED' && analysisDiagnostics.length ? 'PARTIAL' : issueResult.status;
  const normalized = normalizeSonar(root, issueResult.issues, { kind: 'REPORT', reference: `sonarqube://${options.project}`, sourceRevision, measurementStatus: status });
  return {
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
  };
}

module.exports = { DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT, SonarHttpError, connectSonar, createClient, fetchIssues, importSonar, normalizeUrl, readToken, versionProfile };
