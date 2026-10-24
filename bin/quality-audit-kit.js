#!/usr/bin/env node

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  const command = process.argv[2];
  if (command && !command.startsWith('-')) process.stderr.write(`Hint: run quality-audit-kit ${command} --help for the expected syntax.\n`);
  else process.stderr.write('Hint: run quality-audit-kit --help for the core workflow.\n');
  process.exitCode = 1;
});
