# Local CLI prototype

**Status:** EXPERIMENTAL, implemented in this repository and not published to npm.

The package uses only Node.js built-ins and supports Node.js 18 or newer. It does not install dependencies, create a dashboard, require an account or modify the source files of the repository being analyzed.

## Commands

```text
quality-audit-kit init [repository] [--force] [--templates deterministic|none] [--update-templates] [--preview]
quality-audit-kit init [repository] --agent codex [--agent-prompt file] [--agent-input file]
quality-audit-kit init [repository] --link-agents
quality-audit-kit context refresh [repository] [--preview]
quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--run[=knip,jscpd]]
quality-audit-kit report run.json [--format markdown|json] [--output file]
```

When running from a checkout without a package installation, use `node bin/quality-audit-kit.js` in place of `quality-audit-kit`.

`init` detects the package manager, declared workspaces, repository languages, scanner configuration, local scanner binaries, documentation, tests and governance files. It writes `quality-audit-kit.config.json` only when it is missing or `--force` is explicit, and creates the generic `PROJECT_HANDOFF.md` and `COMMIT_REVIEW.md` templates when they are missing.

The templates have a `QAK:BEGIN GENERATED` block and a protected `QAK:BEGIN MANUAL` block. A normal rerun never overwrites an existing template. `--update-templates` refreshes only the generated block and refuses unmanaged or malformed documents. Manual content and the `USER_DECISIONS` block are preserved byte-for-byte. `--preview` emits a deterministic diff preview and performs no mutation.

The generated blocks contain observations only. Architecture, purpose, source-of-truth decisions, risks and control outcomes remain `UNKNOWN` until demonstrated by direct repository inspection. No CleanMyMap-specific rule is embedded in either generic template.

An unsafe template refresh is reported as `BLOCKED` and exits with status 2. Agent proposals containing QAK marker lines or secret-like values are rejected, and a prompt output path must stay inside the analyzed repository.

`context refresh` is narrower than template refresh: it updates only the detected-facts block in `PROJECT_HANDOFF.md` and the detected-controls block in `COMMIT_REVIEW.md`. It reports changed fields such as package manager, languages, workspace paths, scripts, tests, workflows and scanner configurations. Manual instructions, decisions and the generic review protocol are not rewritten. If a manual field explicitly disagrees with a newly detected value, the command preserves both the human text and the new fact, reports `CONTRADICTIONS` and exits with status 2. `--preview` reports the same changes without mutation.

When either context document is absent, the result is `NOT_INITIALIZED` with status 2; use `init` first rather than silently treating missing context as current.

`--agent codex` prepares an optional customization handoff. With `--agent-prompt`, it writes an explicit prompt containing the detected paths. The CLI never launches an agent, installs dependencies or contacts a web service implicitly. A Codex-produced JSON proposal can be applied explicitly with `--agent-input`; its two accepted properties are `projectHandoffGenerated` and `commitReviewGenerated`, and marker lines are rejected. `--link-agents` is opt-in and appends or refreshes a bounded link block only in an existing root `AGENTS.md`.

`scan` detects the same structure and emits the `audit-run` contract. It imports these conventional files when present:

- `knip-report.json`, `.knip-report.json`, `reports/knip.json` or `reports/knip-report.json`;
- `jscpd-report.json`, `reports/jscpd-report.json` or `reports/jscpd.json`.

The Knip adapter accepts the JSON reporter shape with grouped `issues` and issue-type arrays. The jscpd adapter accepts the JSON reporter shape with `duplicates`, `firstFile` and `secondFile`. The normalizer records the scanner, rule, repository-relative file, line when available, severity, stable ID, `UNCLASSIFIED` lifecycle, measurement status and report/execution provenance. `NEW` is reserved for a future real comparison against a baseline or history.

`--run` is the only mode that executes scanners. It resolves `node_modules/.bin/knip` and `node_modules/.bin/jscpd` in the target repository and invokes them directly. It never calls `npx`, `npm install` or a shell command supplied by the analyzed project. Exit code 1 is treated as an expected findings/threshold result for these adapters when a valid JSON report is available; other non-zero codes are `FAILURE`, even if they also emitted JSON. A partial JSON payload after a real execution error is never normalized as a complete measurement. A local scanner may still fail; that result is recorded as `FAILURE` and the command exits with status 2. A scanner that is absent, not requested or skipped is recorded as `NOT_MEASURED` with `gateOutcome: NOT_EVALUATED`.

By default `scan` writes the run JSON to stdout. This avoids changing the analyzed worktree. Use an explicit `--output` path to save a run artifact.

`report` renders a saved run as Markdown by default or reproduces normalized JSON with `--format json`. Reports retain negative measurement states and explicitly warn when no measured findings are available.

## Contract boundaries

The CLI emits `schemaVersion: 0.1-draft`, `inputScope: WORKTREE_LIVE` and `reproducible: false` for the default live-worktree scan. `commitSha` and `contextCommitSha` record the Git context for compatibility and orientation. Imported reports carry `sourceRevision.status: UNKNOWN` unless a future adapter can demonstrate the analyzed revision. Explicit execution is `VERIFIED` only for a clean worktree represented by HEAD; dirty live worktrees are `UNVERIFIED`. A SHA alone never upgrades a live-worktree run or an imported report to immutable proof.

Finding IDs are SHA-256 fingerprints of the engine, rule, normalized repository-relative path and a stable rule-specific locus. Line movement alone is not part of the fingerprint. jscpd fingerprints include the normalized duplicate pair and available fragment/token information; path moves and scanner-specific changes can still legitimately change an ID.

No baseline comparison, triage mutation, SARIF export, package publication, hosted service or automatic remediation is implemented yet.

## References for imported formats

- [Knip reporters](https://knip.dev/features/reporters)
- [jscpd reporters and JSON output](https://github.com/kucherenko/jscpd/blob/master/docs/rust.md)
