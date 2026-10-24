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
    `- Generated: \`${run.generatedAt}\``,
    '',
    '## Measurement status',
    '',
    '| Scanner | Status | Gate outcome | Findings | Diagnostic |',
    '| --- | --- | --- | ---: | --- |',
  ];

  for (const engine of run.engines) {
    const count = run.findings.filter((finding) => finding.engine === engine.name).length;
    lines.push(`| ${engine.name} | ${engine.measurementStatus} | ${engine.gateOutcome} | ${count} | ${engine.diagnostic || ''} |`);
  }

  lines.push('', '## Discovery', '', `- Package manager: \`${discovery.packageManager.name || 'none'}\``, `- Languages: ${discovery.languages.length ? discovery.languages.join(', ') : 'none detected'}`, `- Workspaces: ${discovery.workspaces.packages.length || 0} detected`, `- Configurations: ${discovery.configurations.length || 0}`, '', '## Findings', '');
  if (run.findings.length === 0) {
    lines.push('No measured findings were imported. This does not mean that unmeasured scanners found no problems.');
  } else {
    lines.push('| ID | Scanner | Rule | File | Severity | Measurement |', '| --- | --- | --- | --- | --- | --- |');
    for (const finding of run.findings) {
      lines.push(`| ${finding.id} | ${finding.engine} | ${finding.ruleId} | ${finding.path} | ${finding.severity} | ${finding.measurementStatus} |`);
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
