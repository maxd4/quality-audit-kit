/*
 * Quality Audit Kit - SonarQube browser exporter
 *
 * Paste this complete file into the Chrome DevTools console while viewing an
 * authenticated SonarQube page. It uses only same-origin GET requests to the
 * three Web API endpoints already defined by the Quality Audit Kit connector:
 *   /api/server/version
 *   /api/issues/search
 *   /api/project_analyses/search
 *
 * It never reads browser authentication state or authentication headers. The
 * browser may attach the current session cookie to same-origin fetches, but
 * the script cannot inspect or print it. The only write is a local JSON
 * download created with a Blob; no data is sent to a third party and no
 * SonarQube mutation endpoint is called.
 *
 * Optional configuration: edit CONFIG before pasting. The project key is
 * inferred from the current page query string (`id`, `project` or
 * `component`) when CONFIG.project is null. Keep maxResults <= 10000, as in
 * the Node connector contract.
 */
(() => {
  'use strict';

  const FORMAT = 'quality-audit-kit/sonarqube-browser-export';
  const FORMAT_VERSION = 1;
  const DEFAULT_PAGE_SIZE = 500;
  const MAX_RESULTS_LIMIT = 10000;
  const CONFIG = {
    project: null,
    // Leave empty for the usual root deployment; use "/sonarqube" when the
    // instance is served below a reverse-proxy context path.
    basePath: '',
    branch: null,
    pullRequest: null,
    maxResults: 1000,
    pageSize: DEFAULT_PAGE_SIZE,
    filenamePrefix: 'quality-audit-kit-sonarqube',
  };

  function diagnostic(code, reference, message, details) {
    return { kind: 'SONAR_DIAGNOSTIC', code, reference, message, ...(details ? { details } : {}) };
  }

  function versionProfile(version) {
    const major = Number(String(version || '').split('.')[0]);
    if (!Number.isInteger(major)) return 'unknown-web-api';
    return major >= 10 ? 'web-api-v2-aware-v1-compatible' : major >= 9 ? 'web-api-v1-compatible' : 'legacy-web-api';
  }

  function inspectVersion(version) {
    const value = String(version || '').trim();
    const match = /^(\d+)(?:\.\d+)+(?:[-+].*)?$/.exec(value);
    if (!match) return { status: 'INCOMPATIBLE', reason: 'The server version endpoint did not return a SonarQube version string.' };
    const major = Number(match[1]);
    if (!Number.isSafeInteger(major)) return { status: 'INCOMPATIBLE', reason: 'The SonarQube server version major number could not be interpreted safely.' };
    if (major < 9) return { status: 'INCOMPATIBLE', reason: 'The browser exporter requires the Web API contract used by SonarQube 9 or newer.' };
    return { status: 'COMPATIBLE', profile: versionProfile(value) };
  }

  function resolveConfig(config, location) {
    const params = new URL(location.href).searchParams;
    const project = String(config.project || params.get('id') || params.get('project') || params.get('component') || '').trim();
    const branch = config.branch || params.get('branch') || null;
    const pullRequest = config.pullRequest || params.get('pullRequest') || params.get('pullRequestKey') || null;
    const maxResults = Number(config.maxResults);
    const pageSize = Number(config.pageSize);
    if (!project) throw new Error('No SonarQube project key was found. Set CONFIG.project before pasting the script.');
    if (branch && pullRequest) throw new Error('CONFIG.branch and CONFIG.pullRequest are mutually exclusive.');
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT) throw new Error(`CONFIG.maxResults must be an integer between 1 and ${MAX_RESULTS_LIMIT}.`);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) throw new Error(`CONFIG.pageSize must be an integer between 1 and ${DEFAULT_PAGE_SIZE}.`);
    const basePath = String(config.basePath || '').trim();
    if (basePath && (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#'))) throw new Error('CONFIG.basePath must be an absolute same-origin path such as /sonarqube.');
    return { project, basePath: basePath.replace(/\/+$/, ''), branch, pullRequest, maxResults, pageSize, filenamePrefix: String(config.filenamePrefix || 'quality-audit-kit-sonarqube').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'quality-audit-kit-sonarqube' };
  }

  function apiUrl(location, basePath, pathname, params) {
    const url = new URL(`${basePath}${pathname}`, location.origin);
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    if (url.origin !== location.origin) throw new Error('Refusing a cross-origin SonarQube request.');
    return url;
  }

  async function fetchText(fetchImpl, url) {
    let response;
    try {
      response = await fetchImpl(url.toString(), { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    } catch {
      throw new Error(`SonarQube API request failed before a response was received at ${url.pathname}.`);
    }
    if (!response || !response.ok) throw new Error(`SonarQube API request failed with HTTP ${response?.status || 0} at ${url.pathname}.`);
    try { return await response.text(); } catch { throw new Error(`SonarQube API response could not be read at ${url.pathname}.`); }
  }

  async function fetchJson(fetchImpl, url) {
    const text = await fetchText(fetchImpl, url);
    try { return JSON.parse(text); } catch { throw new Error(`SonarQube API returned invalid JSON at ${url.pathname}.`); }
  }

  function issuePageAssessment(response, requestedPage, requestedSize) {
    const issues = response && Array.isArray(response.issues) ? response.issues : null;
    const paging = response && response.paging && typeof response.paging === 'object' ? response.paging : null;
    const total = paging && Number.isInteger(paging.total) && paging.total >= 0 ? paging.total : null;
    const pageIndex = paging && Number.isInteger(paging.pageIndex) ? paging.pageIndex : null;
    const pageSize = paging && Number.isInteger(paging.pageSize) ? paging.pageSize : null;
    const diagnostics = [];
    if (!issues) diagnostics.push(diagnostic('MALFORMED_ISSUE_RESPONSE', '/api/issues/search', 'SonarQube did not return an issues array.'));
    if (total === null || pageIndex === null || pageSize === null) diagnostics.push(diagnostic('PAGINATION_METADATA_UNAVAILABLE', '/api/issues/search', 'SonarQube did not return complete paging metadata; the export cannot claim completeness.'));
    if (pageIndex !== null && pageIndex !== requestedPage) diagnostics.push(diagnostic('PAGINATION_PAGE_MISMATCH', `/api/issues/search?p=${requestedPage}`, `SonarQube returned page ${pageIndex} for requested page ${requestedPage}.`));
    if (pageSize !== null && pageSize < 1) diagnostics.push(diagnostic('PAGINATION_PAGE_SIZE_INVALID', `/api/issues/search?p=${requestedPage}`, 'SonarQube returned an invalid page size.'));
    if (pageSize !== null && pageSize > requestedSize) diagnostics.push(diagnostic('PAGINATION_PAGE_SIZE_UNEXPECTED', `/api/issues/search?p=${requestedPage}`, 'SonarQube returned more issues than requested; completeness is not assumed.'));
    if (issues && issues.length > requestedSize) diagnostics.push(diagnostic('PAGINATION_ISSUES_OVER_REQUEST', `/api/issues/search?p=${requestedPage}`, `SonarQube returned ${issues.length} issues for a request of ${requestedSize}; only the requested bound is retained.`));
    return { issues: issues || [], paging: paging || null, total, diagnostics };
  }

  async function collect(options = {}, dependencies = {}) {
    const location = dependencies.location || window.location;
    const fetchImpl = dependencies.fetch || window.fetch.bind(window);
    const now = dependencies.now || (() => new Date().toISOString());
    const config = resolveConfig({ ...CONFIG, ...options }, location);
    const base = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: now(),
      status: 'FAILURE',
      source: { origin: location.origin, project: config.project, branch: config.branch, pullRequest: config.pullRequest, version: '', apiProfile: 'unknown-web-api', compatibility: { status: 'UNKNOWN' } },
      serverVersion: { endpoint: '/api/server/version', response: null },
      issues: { endpoint: '/api/issues/search', pagination: { requestedLimit: config.maxResults, pageSize: config.pageSize, reportedTotal: null, exportedCount: 0, pageCount: 0, status: 'UNKNOWN', limitReached: false }, pages: [] },
      analysis: { endpoint: '/api/project_analyses/search', response: null, selected: null },
      diagnostics: [],
    };

    let versionText;
    try {
      versionText = (await fetchText(fetchImpl, apiUrl(location, config.basePath, '/api/server/version'))).trim();
    } catch (error) {
      base.diagnostics.push(diagnostic('VERSION_UNAVAILABLE', '/api/server/version', error.message));
      return base;
    }
    base.serverVersion.response = versionText;
    base.source.version = versionText;
    const compatibility = inspectVersion(versionText);
    base.source.apiProfile = compatibility.profile || versionProfile(versionText);
    base.source.compatibility = compatibility;
    if (compatibility.status !== 'COMPATIBLE') {
      base.status = 'INCOMPATIBLE';
      base.diagnostics.push(diagnostic('INCOMPATIBLE_VERSION', '/api/server/version', compatibility.reason));
      return base;
    }

    let total = null;
    let partial = false;
    let page = 1;
    const issueKeys = new Set();
    while (base.issues.pagination.exportedCount < config.maxResults && (total === null || base.issues.pagination.exportedCount < total)) {
      const requestSize = Math.min(config.pageSize, config.maxResults - base.issues.pagination.exportedCount);
      const query = { componentKeys: config.project, p: page, ps: requestSize, ...(config.branch ? { branch: config.branch } : {}), ...(config.pullRequest ? { pullRequest: config.pullRequest } : {}) };
      let response;
      try {
        response = await fetchJson(fetchImpl, apiUrl(location, config.basePath, '/api/issues/search', query));
      } catch (error) {
        partial = true;
        base.diagnostics.push(diagnostic('PARTIAL_API_RESPONSE', `/api/issues/search?p=${page}`, error.message));
        break;
      }
      const assessment = issuePageAssessment(response, page, requestSize);
      const pageIssues = assessment.issues.slice(0, requestSize);
      if (assessment.diagnostics.length) partial = true;
      const storedResponse = assessment.issues.length > pageIssues.length ? { ...response, issues: pageIssues } : response;
      base.issues.pages.push({ request: query, response: storedResponse });
      base.issues.pagination.pageCount = base.issues.pages.length;
      base.issues.pagination.exportedCount += pageIssues.length;
      base.diagnostics.push(...assessment.diagnostics);
      if (assessment.total !== null) {
        if (total === null) total = assessment.total;
        else if (total !== assessment.total) {
          partial = true;
          base.diagnostics.push(diagnostic('PAGINATION_TOTAL_CHANGED', `/api/issues/search?p=${page}`, 'SonarQube reported different totals across pages; completeness is not established.'));
        }
      } else partial = true;
      for (const issue of pageIssues) {
        const key = issue && issue.key !== undefined ? String(issue.key) : null;
        if (key && issueKeys.has(key)) {
          partial = true;
          base.diagnostics.push(diagnostic('DUPLICATE_ISSUE', `sonarqube://issues/${encodeURIComponent(key)}`, 'The same SonarQube issue appeared on more than one page.'));
        }
        if (key) issueKeys.add(key);
      }
      if (assessment.issues.length > pageIssues.length) break;
      if (!pageIssues.length) break;
      if (total !== null && base.issues.pagination.exportedCount >= total) break;
      if (pageIssues.length < requestSize && total === null) { partial = true; break; }
      page += 1;
    }
    base.issues.pagination.reportedTotal = total;
    if (total !== null && base.issues.pagination.exportedCount > total) {
      partial = true;
      base.diagnostics.push(diagnostic('PAGINATION_COUNT_EXCEEDS_TOTAL', '/api/issues/search', `SonarQube returned ${base.issues.pagination.exportedCount} issues for a reported total of ${total}.`));
    }
    base.issues.pagination.limitReached = total !== null && total > config.maxResults;
    if (base.issues.pagination.limitReached) {
      partial = true;
      base.diagnostics.push(diagnostic('RESULT_LIMIT_REACHED', '/api/issues/search', `SonarQube reported ${total} results; only the configured limit ${config.maxResults} was exported.`));
    }
    if (total !== null && base.issues.pagination.exportedCount < total) partial = true;
    base.issues.pagination.status = !partial && total !== null && base.issues.pagination.exportedCount === total ? 'COMPLETE' : 'PARTIAL';

    try {
      const analysisResponse = await fetchJson(fetchImpl, apiUrl(location, config.basePath, '/api/project_analyses/search', { project: config.project, p: 1, ps: 1, ...(config.branch ? { branch: config.branch } : {}), ...(config.pullRequest ? { pullRequest: config.pullRequest } : {}) }));
      base.analysis.response = analysisResponse;
      base.analysis.selected = Array.isArray(analysisResponse?.analyses) ? analysisResponse.analyses[0] || null : null;
      if (!Array.isArray(analysisResponse?.analyses)) {
        partial = true;
        base.diagnostics.push(diagnostic('ANALYSIS_METADATA_MALFORMED', '/api/project_analyses/search', 'SonarQube did not return an analyses array.'));
      }
    } catch (error) {
      partial = true;
      base.diagnostics.push(diagnostic('ANALYSIS_METADATA_UNAVAILABLE', '/api/project_analyses/search', error.message));
    }
    base.status = partial ? 'PARTIAL' : 'MEASURED';
    return base;
  }

  function download(value, filename, documentObject, urlApi) {
    const documentRef = documentObject || document;
    const urlRef = urlApi || URL;
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
    const objectUrl = urlRef.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.rel = 'noopener';
    link.click();
    urlRef.revokeObjectURL(objectUrl);
  }

  async function start(options = {}) {
    const location = window.location;
    const config = resolveConfig({ ...CONFIG, ...options }, location);
    const result = await collect(config);
    const stamp = result.exportedAt.replace(/[^0-9]/g, '').slice(0, 14) || 'export';
    download(result, `${config.filenamePrefix}-${config.project}-${stamp}.json`);
    console.info(`[Quality Audit Kit] SonarQube export ${result.status}: ${result.issues.pagination.exportedCount}/${result.issues.pagination.reportedTotal ?? '?'} issues, ${result.diagnostics.length} diagnostic(s).`);
    return result;
  }

  const api = { collect, download, start, versionProfile };
  globalThis.QualityAuditKitSonarExporter = api;
  if (typeof window !== 'undefined' && window.__QAK_SONAR_EXPORTER_DISABLE_AUTO_START__ !== true) {
    start().catch((error) => console.error(`[Quality Audit Kit] SonarQube export stopped: ${error.message}`));
  }
})();
