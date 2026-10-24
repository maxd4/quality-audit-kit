#!/usr/bin/env node

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
