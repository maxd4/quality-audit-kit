const fs = require('node:fs');

function renderMarkdown(run) {
  const discovery = run.discovery || {
    packageManager: { name: null },
    languages: [],
    workspaces: { packages: [] },
    configurations: [],
  };
  const lines = [
    '# Quality Audit Kit report',
    '',
    `- Repository: \`${run.repository.name}\``,
    `- Run: \`${run.runId}\``,
    `- Input scope: \`${run.inputScope}\``,
    `- Reproducible: \`${run.reproducible}\``,
    `- Context Git commit: \`${run.repository.contextCommitSha || run.repository.commitSha || 'UNKNOWN'}\``,
    `- Generated: \`${run.generatedAt}\``,
    '',
    '## Measurement status',
    '',
    '| Scanner | Status | Source revision | Gate outcome | Findings | Diagnostic |',
    '| --- | --- | --- | --- | ---: | --- |',
  ];

  for (const engine of run.engines) {
    const count = run.findings.filter((finding) => finding.engine === engine.name).length;
    lines.push(`| ${engine.name} | ${engine.measurementStatus} | ${engine.sourceRevision?.status || 'UNKNOWN'} | ${engine.gateOutcome} | ${count} | ${engine.diagnostic || ''} |`);
  }

  lines.push('', '## Discovery', '', `- Package manager: \`${discovery.packageManager.name || 'none'}\``, `- Languages: ${discovery.languages.length ? discovery.languages.join(', ') : 'none detected'}`, `- Workspaces: ${discovery.workspaces.packages.length || 0} detected`, `- Configurations: ${discovery.configurations.length || 0}`, '', '## Findings', '');
  if (run.comparison) {
    lines.push('## Historical comparison', '', `- Status: \`${run.comparison.status}\``, `- Baseline run: \`${run.comparison.baselineRunId || 'UNKNOWN'}\``, `- Matches: ${(run.comparison.matches || []).length}`, `- Resolved: ${(run.comparison.resolved || []).length}`, '');
    if (run.comparison.reasons?.length) lines.push(`- Reasons: ${run.comparison.reasons.join(' ')}`, '');
  }
  if (run.qualityGate) {
    lines.push('## Quality gate', '', `- Status: \`${run.qualityGate.status}\``, `- New blocking findings: ${(run.qualityGate.newBlockingFindings || []).length}`, `- Stale decisions: ${(run.comparison?.staleDecisions || []).filter((decision) => decision.status === 'STALE').length}`, '');
    for (const proposal of run.qualityGate.proposals || []) lines.push(`- Proposal only: ${proposal.message}`);
    if (run.qualityGate.blockedReasons?.length) lines.push(`- Blocked reasons: ${run.qualityGate.blockedReasons.join(' ')}`);
    lines.push('');
  }
  if (run.findings.length === 0) {
    lines.push('No findings were recorded. This does not mean that unmeasured or failed scanners found no problems.');
  } else {
    lines.push('| ID | Scanner | Rule | File | Severity | Lifecycle | Measurement | Source revision |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const finding of run.findings) {
      lines.push(`| ${finding.id} | ${finding.engine} | ${finding.ruleId} | ${finding.path} | ${finding.severity} | ${finding.lifecycle} | ${finding.measurementStatus} | ${finding.provenance?.sourceRevision?.status || 'UNKNOWN'} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeOutput(outputPath, content) {
  if (!outputPath || outputPath === '-') return false;
  fs.writeFileSync(outputPath, content, 'utf8');
  return true;
}

module.exports = { renderMarkdown, writeOutput };
