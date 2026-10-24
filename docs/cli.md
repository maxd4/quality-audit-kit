# Local CLI prototype

**Status:** EXPERIMENTAL, implemented in this repository and not published to npm.

The package uses only Node.js built-ins and supports Node.js 18 or newer. It does not install dependencies, create a dashboard, require an account or modify the source files of the repository being analyzed.

## Commands

```text
quality-audit-kit init [repository] [--force]
quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--run[=knip,jscpd]]
quality-audit-kit report run.json [--format markdown|json] [--output file]
```

When running from a checkout without a package installation, use `node bin/quality-audit-kit.js` in place of `quality-audit-kit`.

`init` detects the package manager, declared workspaces, repository languages, scanner configuration and local scanner binaries, then writes `quality-audit-kit.config.json`. It refuses to overwrite an existing config unless `--force` is explicit.

`scan` detects the same structure and emits the `audit-run` contract. It imports these conventional files when present:

- `knip-report.json`, `.knip-report.json`, `reports/knip.json` or `reports/knip-report.json`;
- `jscpd-report.json`, `reports/jscpd-report.json` or `reports/jscpd.json`.

The Knip adapter accepts the JSON reporter shape with grouped `issues` and issue-type arrays. The jscpd adapter accepts the JSON reporter shape with `duplicates`, `firstFile` and `secondFile`. The normalizer records the scanner, rule, repository-relative file, line when available, severity, stable ID, measurement status and report/execution provenance.

`--run` is the only mode that executes scanners. It resolves `node_modules/.bin/knip` and `node_modules/.bin/jscpd` in the target repository and invokes them directly. It never calls `npx`, `npm install` or a shell command supplied by the analyzed project. A local scanner may still fail; that result is recorded as `FAILURE` and the command exits with status 2. A scanner that is absent, not requested or skipped is recorded as `NOT_MEASURED` with `gateOutcome: NOT_EVALUATED`.

By default `scan` writes the run JSON to stdout. This avoids changing the analyzed worktree. Use an explicit `--output` path to save a run artifact.

`report` renders a saved run as Markdown by default or reproduces normalized JSON with `--format json`. Reports retain negative measurement states and explicitly warn when no measured findings are available.

## Contract boundaries

The CLI emits `schemaVersion: 0.1-draft`, `inputScope: WORKTREE_LIVE` and `reproducible: false` for the default live-worktree scan. A Git commit SHA is recorded when the target is a Git checkout, but a SHA alone does not upgrade a live-worktree run to immutable proof.

Finding IDs are SHA-256 fingerprints of the engine, rule, normalized repository-relative path and a stable rule-specific locus. Line movement alone is not part of the fingerprint. jscpd fingerprints include the normalized duplicate pair and available fragment/token information; path moves and scanner-specific changes can still legitimately change an ID.

No baseline comparison, triage mutation, SARIF export, package publication, hosted service or automatic remediation is implemented yet.

## References for imported formats

- [Knip reporters](https://knip.dev/features/reporters)
- [jscpd reporters and JSON output](https://github.com/kucherenko/jscpd/blob/master/docs/rust.md)
