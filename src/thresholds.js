const crypto = require('node:crypto');
const path = require('node:path');

const MIN_SAMPLE_SIZE = 4;
const FILE_CATEGORIES = ['runtime', 'tests', 'configuration', 'generated', 'unknown'];
const DIRECTIONS = ['LOWER_IS_BETTER', 'HIGHER_IS_BETTER'];
const PROFILES = [
  {
    id: 'progressive',
    label: 'progressif',
    formula: 'q50',
    explanation: 'Objectif de transition fondé sur la médiane observée, sans utiliser un quantile élevé comme norme.',
  },
  {
    id: 'balanced',
    label: 'équilibré',
    formula: 'q25-or-q50',
    explanation: 'Objectif plus exigeant pour les métriques où moins est préférable ; q50 est conservé pour les petits échantillons et les métriques à hausse souhaitable.',
  },
  {
    id: 'strict',
    label: 'strict',
    formula: 'extreme',
    explanation: 'Objectif aligné sur l’extrême actuellement observé ; il reste une proposition à approuver, jamais une nouvelle norme automatique.',
  },
];

function stableId(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function round(value) {
  if (value === null || value === undefined) return null;
  return Number(Number(value).toFixed(6));
}

function quantile(values, probability) {
  if (!values.length) return null;
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + ((values[upper] - values[lower]) * (position - lower));
}

function distribution(samples) {
  const sorted = samples.map((sample) => sample.value).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const q25 = quantile(sorted, 0.25);
  const q50 = quantile(sorted, 0.5);
  const q75 = quantile(sorted, 0.75);
  const iqr = q75 === null || q25 === null ? null : q75 - q25;
  const lowerFence = iqr === null ? null : q25 - (iqr * 1.5);
  const upperFence = iqr === null ? null : q75 + (iqr * 1.5);
  const outliers = lowerFence === null ? [] : samples
    .filter((sample) => sample.value < lowerFence || sample.value > upperFence)
    .map((sample) => sample.value);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
    q25: round(q25),
    q50: round(q50),
    q75: round(q75),
    q90: round(quantile(sorted, 0.9)),
    q95: round(quantile(sorted, 0.95)),
    extremes: {
      lowest: sorted.slice(0, 3).map(round),
      highest: sorted.slice(-3).reverse().map(round),
    },
    outlierRule: '1.5*IQR',
    outlierFences: { lower: round(lowerFence), upper: round(upperFence) },
    outlierCount: outliers.length,
  };
}

function normalizeDirection(value, name) {
  const normalized = String(value || '').toUpperCase().replace(/[- ]/g, '_');
  if (DIRECTIONS.includes(normalized)) return normalized;
  return /(_COUNT|COUNT$|FINDING|DUPLICAT|UNUSED|ERROR|WARNING|DEBT|ISSUE)/i.test(name)
    ? 'LOWER_IS_BETTER'
    : 'LOWER_IS_BETTER';
}

function normalizeCategory(value) {
  const normalized = String(value || '').toLowerCase();
  return FILE_CATEGORIES.includes(normalized) ? normalized : 'unknown';
}

function normalizeDimension(value) {
  if (value === undefined || value === null || value === '') return 'UNKNOWN';
  return String(value);
}

function inferLanguage(filePath) {
  const extension = path.extname(filePath || '').toLowerCase();
  const map = {
    '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.go': 'go', '.java': 'java',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.kt': 'kotlin', '.php': 'php', '.py': 'python', '.rb': 'ruby', '.rs': 'rust',
    '.swift': 'swift', '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'vue',
  };
  return map[extension] || 'UNKNOWN';
}

function inferFileCategory(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(generated|dist|build|coverage|\.next)(\/|$)/.test(normalized) || /\.generated\./.test(normalized)) return 'generated';
  if (/(^|\/)(__tests__|tests?|specs?|fixtures?)(\/|$)/.test(normalized) || /\.(test|spec)\.[^.]+$/.test(normalized)) return 'tests';
  if (/(^|\/)(package\.json|.*config[^/]*|.*\.config\.[^.]+|.*\.(json|ya?ml|toml))$/.test(normalized) || /(^|\/)\.[^/]+$/.test(normalized)) return 'configuration';
  return 'runtime';
}

function workspaceForPath(filePath, discovery) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const packages = Array.isArray(discovery?.workspaces?.packages) ? discovery.workspaces.packages : [];
  const matches = packages
    .map((workspace) => String(workspace).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((workspace) => workspace && (normalized === workspace || normalized.startsWith(`${workspace}/`)))
    .sort((a, b) => b.length - a.length);
  return matches[0] || 'root';
}

function dimensionsForFinding(finding, run) {
  const fileCategory = finding.fileCategory || finding.category || finding.planning?.fileCategory || inferFileCategory(finding.path);
  return {
    language: normalizeDimension(finding.language || inferLanguage(finding.path)),
    workspace: normalizeDimension(finding.workspace || workspaceForPath(finding.path, run.discovery)),
    fileCategory: normalizeCategory(fileCategory),
    scope: normalizeDimension(finding.scope || run.inputScope),
  };
}

function dimensionsForMetric(metric, run) {
  return {
    language: normalizeDimension(metric.language),
    workspace: normalizeDimension(metric.workspace),
    fileCategory: normalizeCategory(metric.fileCategory || metric.category),
    scope: normalizeDimension(metric.scope || run.inputScope),
  };
}

function groupKey(record) {
  return JSON.stringify({
    name: record.name,
    unit: record.unit,
    direction: record.direction,
    ...record.dimensions,
  });
}

function metricValue(metric) {
  if (typeof metric === 'number') return Number.isFinite(metric) && metric >= 0 ? metric : null;
  const value = metric.value ?? metric.measurement ?? metric.count;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function explicitRecords(run, warnings) {
  if (!Array.isArray(run.metrics)) return [];
  const records = [];
  for (const [metricIndex, metric] of run.metrics.entries()) {
    const observations = Array.isArray(metric.values) ? metric.values : [metric];
    for (const [observationIndex, observation] of observations.entries()) {
      const status = String(observation.status || metric.status || 'MEASURED').toUpperCase();
      if (status !== 'MEASURED') {
        warnings.push({ source: 'metric', metric: metric.name || metric.metric || `metric-${metricIndex}`, status, reason: 'Non-measured metric excluded from recommendations.' });
        continue;
      }
      const value = metricValue(observation);
      if (value === null) {
        warnings.push({ source: 'metric', metric: metric.name || metric.metric || `metric-${metricIndex}`, status: 'INVALID', reason: 'Metric has no finite non-negative numeric value.' });
        continue;
      }
      const name = String(observation.name || metric.name || observation.metric || metric.metric || 'unnamed_metric');
      records.push({
        name,
        unit: String(observation.unit || metric.unit || 'unit'),
        direction: normalizeDirection(observation.direction || metric.direction, name),
        dimensions: dimensionsForMetric({ ...metric, ...observation }, run),
        value,
        findingIds: Array.isArray(observation.findingIds) ? observation.findingIds : Array.isArray(metric.findingIds) ? metric.findingIds : [],
        findingCount: Number.isInteger(observation.findingCount) ? observation.findingCount : Number.isInteger(metric.findingCount) ? metric.findingCount : null,
        source: 'EXPLICIT_METRIC',
        sourceReference: observation.provenance || metric.provenance || null,
        degraded: observation.degraded === true || metric.degraded === true || String(observation.qualityState || metric.qualityState || run.qualityState || '').toUpperCase() === 'DEGRADED',
        sampleIndex: observationIndex,
      });
    }
  }
  return records;
}

function derivedFindingRecords(run, warnings) {
  const measuredEngines = new Set((run.engines || [])
    .filter((engine) => engine.measurementStatus === 'MEASURED')
    .map((engine) => engine.name));
  for (const engine of (run.engines || [])) {
    if (engine.measurementStatus !== 'MEASURED') warnings.push({ source: 'engine', engine: engine.name, status: engine.measurementStatus, reason: 'Findings from unavailable, failed or skipped scanners are not counted as zero.' });
  }
  const groups = new Map();
  for (const finding of (run.findings || [])) {
    if (finding.measurementStatus !== 'MEASURED' || (measuredEngines.size && !measuredEngines.has(finding.engine))) continue;
    const dimensions = dimensionsForFinding(finding, run);
    const record = {
      name: 'finding_count',
      unit: 'findings',
      direction: 'LOWER_IS_BETTER',
      dimensions,
      value: 0,
      findingIds: [],
      findingCount: 0,
      source: 'DERIVED_FINDINGS',
      sourceReference: finding.engine,
      degraded: String(run.qualityState || '').toUpperCase() === 'DEGRADED',
    };
    const key = groupKey(record);
    if (!groups.has(key)) groups.set(key, record);
    const group = groups.get(key);
    group.value += 1;
    group.findingCount += 1;
    group.findingIds.push(finding.id);
  }
  return [...groups.values()];
}

function collectRecords(run) {
  const warnings = [];
  const explicit = explicitRecords(run, warnings);
  const derived = explicit.length ? [] : derivedFindingRecords(run, warnings);
  return { records: [...explicit, ...derived], warnings, explicitCount: explicit.length, derivedCount: derived.length };
}

function capCandidates(baseline, config) {
  const candidates = [];
  const sources = [
    { value: baseline?.thresholds?.metrics, kind: 'BASELINE_THRESHOLDS', runId: baseline?.runId },
    { value: baseline?.baseline?.thresholds?.metrics, kind: 'BASELINE_THRESHOLDS', runId: baseline?.baseline?.runId },
    { value: baseline?.baseline?.policySnapshot?.thresholds?.metrics, kind: 'BASELINE_POLICY', runId: baseline?.baseline?.runId },
    { value: config?.quality?.thresholds?.ratchet?.metrics, kind: 'CONFIGURED_RATCHET', runId: config?.quality?.thresholds?.ratchet?.runId },
  ];
  for (const source of sources) {
    if (!Array.isArray(source.value)) continue;
    for (const candidate of source.value) {
      const value = metricValue(candidate);
      if (value !== null) candidates.push({ ...candidate, value, kind: source.kind, sourceRunId: source.runId || null });
    }
  }
  const legacy = baseline?.baseline?.policySnapshot?.maxMeasuredFindings ?? baseline?.policySnapshot?.maxMeasuredFindings;
  if (legacy !== null && legacy !== undefined) candidates.push({ name: 'finding_count', unit: 'findings', value: legacy, direction: 'LOWER_IS_BETTER', kind: 'BASELINE_POLICY', sourceRunId: baseline?.runId || baseline?.baseline?.runId || null, global: true });
  return candidates;
}

function candidateMatches(candidate, series) {
  if (String(candidate.name || candidate.metric) !== series.name) return false;
  if (candidate.unit !== series.unit || !candidate.direction || normalizeDirection(candidate.direction, series.name) !== series.direction) return false;
  if (candidate.global === true) return true;
  for (const key of ['language', 'workspace', 'fileCategory', 'scope']) {
    if (candidate[key] === undefined || normalizeDimension(candidate[key]) !== series.dimensions[key]) return false;
  }
  return true;
}

function historicalCap(series, baseline, config) {
  const compatible = capCandidates(baseline, config).filter((item) => candidateMatches(item, series));
  if (!compatible.length) return { status: 'UNKNOWN', value: null, reason: 'No compatible historical ratchet cap was provided.', candidates: [] };
  const values = compatible.map((candidate) => candidate.value);
  const value = series.direction === 'HIGHER_IS_BETTER' ? Math.max(...values) : Math.min(...values);
  const selected = compatible.filter((candidate) => candidate.value === value);
  return {
    status: 'KNOWN',
    value: round(value),
    unit: series.unit,
    direction: series.direction,
    source: selected.length === 1 ? selected[0].kind : 'STRICTEST_OF_COMPATIBLE_CAPS',
    sourceRunId: selected.length === 1 ? selected[0].sourceRunId : null,
    constraint: series.direction === 'HIGHER_IS_BETTER' ? 'MAXIMUM_FLOOR' : 'MINIMUM_CEILING',
    candidates: compatible.map((candidate) => ({
      value: round(candidate.value),
      kind: candidate.kind,
      sourceRunId: candidate.sourceRunId || null,
    })),
  };
}

function confidence(sampleCount, outlierCount, generated) {
  if (generated) return 'LOW';
  if (sampleCount < MIN_SAMPLE_SIZE) return 'LOW';
  if (outlierCount > 0) return 'MEDIUM';
  if (sampleCount >= 10) return 'HIGH';
  return 'MEDIUM';
}

function objectiveFor(series, profileId, cap) {
  if (series.samples.length < MIN_SAMPLE_SIZE || series.generated || series.degraded) return null;
  const d = series.distribution;
  let value;
  let basis;
  if (series.direction === 'HIGHER_IS_BETTER') {
    value = profileId === 'strict' ? d.max : d.q50;
    basis = profileId === 'strict' ? 'max' : 'q50';
  } else {
    value = profileId === 'progressive' ? d.q50 : profileId === 'balanced' ? d.q25 : d.min;
    basis = profileId === 'progressive' ? 'q50' : profileId === 'balanced' ? 'q25' : 'min';
  }
  let adjusted = value;
  let capInfluence = 'NONE';
  if (cap.status === 'KNOWN') {
    if (series.direction === 'HIGHER_IS_BETTER') {
      if (adjusted < cap.value) { adjusted = cap.value; capInfluence = 'HISTORICAL_FLOOR'; }
    } else if (adjusted > cap.value) {
      adjusted = cap.value;
      capInfluence = 'HISTORICAL_CEILING';
    }
  }
  return { value: round(adjusted), rawValue: round(value), basis, capInfluence };
}

function proposalFor(series, profile, cap) {
  const objective = objectiveFor(series, profile.id, cap);
  const generated = series.generated;
  const status = generated ? 'EXCLUDED_BY_DEFAULT' : series.samples.length < MIN_SAMPLE_SIZE ? 'INSUFFICIENT_DATA' : series.degraded ? 'REVIEW_REQUIRED' : 'PROPOSED';
  const findingCount = series.findingIds.size || (series.findingCountKnown ? series.findingCount : null);
  const exceeded = (threshold) => {
    if (threshold === null || threshold === undefined) return [];
    return series.samples.filter((sample) => series.direction === 'HIGHER_IS_BETTER' ? sample.value < threshold : sample.value > threshold).map((sample) => sample.value);
  };
  const capExceeded = cap.status === 'KNOWN' ? exceeded(cap.value) : [];
  const targetExceeded = objective ? exceeded(objective.value) : [];
  const justifications = [
    `Distribution de ${series.samples.length} mesure(s): min=${series.distribution.min}, médiane=${series.distribution.q50}, max=${series.distribution.max}.`,
    `La proposition utilise ${objective?.basis || 'aucune base normative'} et n'utilise jamais q90, q95 ou un autre quantile élevé comme norme automatique.`,
  ];
  if (series.distribution.outlierCount) justifications.push(`${series.distribution.outlierCount} mesure(s) est/sont au-delà de la clôture IQR 1.5; la confiance est réduite.`);
  if (series.degraded) justifications.push('La source est marquée dégradée : aucune cible normative n’est proposée automatiquement.');
  if (generated) justifications.push('La catégorie generated est informative et exclue par défaut des seuils normatifs.');
  if (series.samples.length < MIN_SAMPLE_SIZE) justifications.push(`Échantillon insuffisant: ${MIN_SAMPLE_SIZE} mesures sont nécessaires pour proposer une cible.`);
  return {
    proposalId: stableId({ series: series.id, profile: profile.id }),
    profile: profile.id,
    profileLabel: profile.label,
    status,
    metric: { name: series.name, unit: series.unit, direction: series.direction },
    dimensions: series.dimensions,
    currentMeasurement: {
      latest: round(series.samples[series.samples.length - 1]?.value),
      distribution: series.distribution,
      sourceTypes: [...new Set(series.samples.map((sample) => sample.source))],
    },
    recommendedObjective: objective ? { value: objective.value, unit: series.unit, direction: series.direction, basis: objective.basis, rawValue: objective.rawValue } : null,
    statisticalProposal: objective ? { value: objective.rawValue, unit: series.unit, direction: series.direction, basis: objective.basis } : null,
    historicalRatchetCap: cap,
    exceedances: {
      aboveHistoricalRatchet: capExceeded.length,
      aboveRecommendedObjective: targetExceeded.length,
      semantics: series.direction === 'HIGHER_IS_BETTER' ? 'below-threshold-is-counted' : 'above-threshold-is-counted',
    },
    findingCount,
    confidence: confidence(series.samples.length, series.distribution.outlierCount, generated),
    justification: justifications,
    consequences: {
      requiresExplicitApproval: true,
      modifiesNormativePolicy: Boolean(objective),
      wouldTightenHistoricalRatchet: objective ? objective.capInfluence !== 'NONE' || cap.status === 'UNKNOWN' : false,
      wouldRelaxHistoricalRatchet: false,
      generatedExcludedByDefault: generated,
      affectedFindings: findingCount,
      application: objective
        ? 'L’application modifierait la configuration normative et doit être explicitement approuvée.'
        : 'Aucune application normative possible tant que la mesure ou sa qualité ne fournit pas de preuve suffisante.',
    },
  };
}

function buildSeries(records) {
  const groups = new Map();
  for (const record of records) {
    const key = groupKey(record);
    if (!groups.has(key)) groups.set(key, {
      id: stableId({ key }),
      name: record.name,
      unit: record.unit,
      direction: record.direction,
      dimensions: record.dimensions,
      samples: [],
      findingIds: new Set(),
      findingCount: null,
      findingCountKnown: false,
      degraded: false,
      generated: record.dimensions.fileCategory === 'generated',
    });
    const series = groups.get(key);
    series.samples.push(record);
    for (const id of record.findingIds || []) series.findingIds.add(id);
    if (record.findingCount !== null && record.findingCount !== undefined) {
      series.findingCount = series.findingCount === null ? record.findingCount : Math.max(series.findingCount, record.findingCount);
      series.findingCountKnown = true;
    }
    series.degraded ||= record.degraded;
  }
  return [...groups.values()].map((series) => ({
    ...series,
    distribution: distribution(series.samples),
  }));
}

function recommendThresholds(run, options = {}) {
  const { records, warnings, explicitCount, derivedCount } = collectRecords(run);
  const series = buildSeries(records);
  const proposals = series.flatMap((item) => PROFILES.map((profile) => proposalFor(item, profile, historicalCap(item, options.baseline, options.config))));
  const unavailable = (run.engines || []).filter((engine) => engine.measurementStatus !== 'MEASURED').map((engine) => ({ name: engine.name, status: engine.measurementStatus }));
  if (!series.length) warnings.push({ source: 'run', status: 'INSUFFICIENT_DATA', reason: 'No measured explicit metric or finding count is available.' });
  return {
    schemaVersion: '0.1-draft',
    recommendationVersion: '0.1-draft',
    kind: 'QUALITY_THRESHOLDS_RECOMMENDATION',
    runId: run.runId || null,
    repository: run.repository?.name || null,
    inputScope: run.inputScope || null,
    status: series.length ? 'AVAILABLE' : 'INSUFFICIENT_DATA',
    policyStatement: 'Recommendations are advisory. High quantiles from a degraded repository are never promoted automatically to normative thresholds.',
    profiles: PROFILES,
    measurement: {
      explicitMetricRecordCount: explicitCount,
      derivedFindingSeriesCount: derivedCount,
      unavailableEngines: unavailable,
      warnings,
    },
    series: series.map((item) => ({
      seriesId: item.id,
      metric: { name: item.name, unit: item.unit, direction: item.direction },
      dimensions: item.dimensions,
      distribution: item.distribution,
      sampleCount: item.samples.length,
      generatedExcludedByDefault: item.generated,
    })),
    proposals,
    noGlobalQualityScore: true,
  };
}

function buildThresholdConfig(result, profileId = 'balanced') {
  const selected = result.proposals.filter((proposal) => proposal.profile === profileId && proposal.status === 'PROPOSED' && proposal.recommendedObjective);
  const thresholds = selected.map((proposal) => ({
    metric: proposal.metric.name,
    unit: proposal.metric.unit,
    direction: proposal.metric.direction,
    ...proposal.dimensions,
    value: proposal.recommendedObjective.value,
    sourceProposalId: proposal.proposalId,
  }));
  return {
    schemaVersion: '0.1-draft',
    kind: 'QUALITY_THRESHOLDS_PROPOSAL',
    approvalRequired: true,
    runId: result.runId,
    profile: profileId,
    policyStatement: 'This is a proposal. It must be reviewed and explicitly approved before becoming normative.',
    thresholds,
    sourceProposalIds: selected.map((proposal) => proposal.proposalId),
  };
}

function renderThresholdsMarkdown(result) {
  const lines = [
    '# Quality Audit Kit threshold recommendations',
    '',
    `- Status: **${result.status}**`,
    `- Run: \`${result.runId || 'UNKNOWN'}\``,
    `- Normative changes: **explicit approval required**`,
    `- Global quality score: **not computed**`,
    '',
    result.policyStatement,
    '',
    '| Profil | Métrique | Dimensions | Mesure actuelle | Objectif recommandé | Plafond ratcheté | Findings | Confiance | État |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const proposal of result.proposals) {
    const dimensions = Object.entries(proposal.dimensions).map(([key, value]) => `${key}=${value}`).join(', ');
    lines.push(`| ${proposal.profileLabel} | ${proposal.metric.name} (${proposal.metric.unit}) | ${dimensions} | ${proposal.currentMeasurement.latest ?? 'UNKNOWN'} | ${proposal.recommendedObjective?.value ?? 'UNKNOWN'} | ${proposal.historicalRatchetCap.value ?? 'UNKNOWN'} | ${proposal.findingCount ?? 'UNKNOWN'} | ${proposal.confidence} | ${proposal.status} |`);
    lines.push(`  Justification: ${proposal.justification.join(' ')}`);
    lines.push(`  Conséquence: ${proposal.consequences.application}`);
  }
  if (!result.proposals.length) lines.push('| — | — | — | UNKNOWN | UNKNOWN | UNKNOWN | 0 | UNKNOWN | INSUFFICIENT_DATA |');
  lines.push('', '## Mesure et limites', '', `- Mesures explicites: ${result.measurement.explicitMetricRecordCount}`, `- Séries dérivées de findings mesurés: ${result.measurement.derivedFindingSeriesCount}`, `- Scanners indisponibles ou non mesurés: ${result.measurement.unavailableEngines.map((item) => `${item.name}=${item.status}`).join(', ') || 'aucun signalé'}`, '', 'Les quantiles élevés restent descriptifs et ne deviennent pas automatiquement des normes.');
  return `${lines.join('\n')}\n`;
}

module.exports = {
  FILE_CATEGORIES,
  PROFILES,
  buildThresholdConfig,
  inferFileCategory,
  recommendThresholds,
  renderThresholdsMarkdown,
};
