# Local CLI prototype

**Status:** EXPERIMENTAL, implemented in this repository and not published to npm.

The package uses only Node.js built-ins and supports Node.js 18 or newer. It does not install dependencies, create a dashboard, require an account or modify the source files of the repository being analyzed.

## Commands

```text
quality-audit-kit init [repository] [--force] [--templates deterministic|none] [--update-templates] [--preview]
quality-audit-kit init [repository] --agent codex [--agent-prompt file] [--agent-input file]
quality-audit-kit init [repository] --link-agents
quality-audit-kit context refresh [repository] [--preview]
quality-audit-kit scan [repository] [--output file] [--knip-report file] [--jscpd-report file] [--sarif-report file] [--run[=knip,jscpd]] [--baseline file] [--decisions file]
quality-audit-kit connect sonar [--sonar-url URL] [--sonar-project KEY] [--sonar-token-env NAME|--sonar-token-file FILE]
quality-audit-kit import sonar [repository] --sonar-url URL --sonar-project KEY [--sonar-branch NAME|--sonar-pull-request KEY] [--sonar-max-results N] [--output file]
quality-audit-kit import sarif report.sarif [--repository repository] [--output file]
quality-audit-kit baseline run.json [--output file] [--replace] [--preview]
quality-audit-kit triage run.json [--baseline file] [--decisions file] [--finding id --decision FIX|DEFER|KEEP_JUSTIFIED|FALSE_POSITIVE --reason text --reviewer name --reviewed-revision sha --evidence TYPE|REFERENCE|OUTCOME]
quality-audit-kit report run.json [--format terminal|markdown|json|sarif] [--output file] [--bundle file.zip] [--include-evidence file[,file...]]
quality-audit-kit report --verify-bundle file.zip
quality-audit-kit plan run.json [--output plan.json] [--markdown plan.md] [--baseline file] [--decisions file]
quality-audit-kit plan --next [plan.json]
quality-audit-kit plan --export plan.json [--output prompts-directory]
quality-audit-kit fix --next [plan.json] [--output fix-result.json]
quality-audit-kit fix --next [plan.json] --execute --approve [--agent codex|command|deterministic] [--codex-command executable]
quality-audit-kit verify fix-result.json [--output verification.json]
quality-audit-kit thresholds recommend run.json [--baseline file] [--format json|markdown] [--output file] [--export config.json] [--profile progressive|balanced|strict]
quality-audit-kit thresholds recommend run.json --apply --approve [--profile progressive|balanced|strict]
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

With `--baseline`, `scan` compares the run only when the baseline and current run have the same repository, input scope and complete `MEASURED` engines with `VERIFIED` source revisions. Imported reports with unknown source revisions and incomplete analyses produce `NOT_EVALUATED`; they never produce `RESOLVED`. Compatible findings are classified as `NEW`, `HISTORICAL_ACTIONABLE`, `HISTORICAL_JUSTIFIED`, `RESOLVED` or `REINTRODUCED`. Exact IDs preserve line moves. A unique comparison key can preserve history across a file move; ambiguous matches remain unclassified as new rather than being guessed.

`baseline run.json` creates `quality-audit-kit.baseline.json` (or `--output`) only from a complete measured run. An existing baseline is protected; replacement requires `--replace`. Replacements preserve prior run snapshots for reintroduction detection and capture the ratchet policy. `baseline --preview` shows the proposed artifact without writing it.

`triage run.json` evaluates a run against a baseline and reports stale decisions. With `--finding`, it appends one evidence-backed decision to the decision bundle without deleting earlier evidence. The supported public decisions are `FIX`, `DEFER`, `KEEP_JUSTIFIED` and `FALSE_POSITIVE`; each requires a reason, reviewer, reviewed Git revision and at least one evidence item. Expired `reviewAfter` values, disappeared justified findings and changed file scope are `STALE` and cannot silently justify a gate.

The configured ratchet lives under `quality.ratchet` in `quality-audit-kit.config.json`:

```json
{
  "quality": {
    "baseline": "quality-audit-kit.baseline.json",
    "decisions": "quality-audit-kit.decisions.json",
    "ratchet": {
      "blockingSeverities": ["HIGH", "CRITICAL"],
      "maxNewBlockingFindings": 0,
      "maxMeasuredFindings": null
    }
  }
}
```

New or reintroduced blocking findings fail the gate when they exceed `maxNewBlockingFindings`. A measured reduction may emit a `STRICTER_CEILING` proposal, but the CLI never changes a baseline, raises a ceiling or weakens a policy automatically.

By default `scan` writes the run JSON to stdout. This avoids changing the analyzed worktree. Use an explicit `--output` path to save a run artifact.

`report` renders a saved run as a readable terminal summary by default. `--format markdown` writes a deterministic Markdown report and `--format json` writes the structured report contract in [`schemas/report.schema.json`](../schemas/report.schema.json). Every measurement repeats its `runId`, source SHA (when proven), context SHA, scope, engine, version, measurement status and validation state. Findings are separated into new, historical actionable, historical justified, resolved, reintroduced and unclassified groups; measurement failures and recommendations are separate. No global quality score is emitted.

`report --format zip --output quality-audit-kit-run.zip` creates a deterministic offline bundle. It contains the sanitized run, structured JSON, Markdown, terminal summary, `manifest.json`, `inventory.json`, `checksums.sha256` and `VERIFY.txt`. `report --verify-bundle quality-audit-kit-run.zip` validates the ZIP, rejects duplicate or unlisted entries, recalculates byte counts and SHA-256 values against the actual contents, and checks manifest, inventory, runId and context SHA without network access. `--include-evidence file[,file...]` is optional and only accepts explicitly authorized, non-source text/report files inside the run directory; real-path resolution rejects symlink or parent-directory escapes, while source files, secret-like names, binary files and detected tokens are refused. Output files are written atomically and existing artifacts are never overwritten. A successful verification proves internal bundle consistency only; it is not cryptographic authorship or code-quality attestation.

`scan --sarif-report report.sarif` imports a local SARIF 2.1.0 document through the canonical normalizer. `report --format sarif` exports canonical findings; lifecycle, measurement state, provenance and non-representable diagnostics are retained in SARIF properties. Unsupported locations are explicit diagnostics, not silently dropped.

`connect sonar` checks `/api/server/version`. `import sonar` reads `/api/issues/search` and `/api/project_analyses/search`, paginates with a bounded limit (default 1000, maximum 10000), records project/branch/pull-request/version metadata and preserves partial or permission failures. Tokens come only from `SONAR_TOKEN`/`--sonar-token-env` or a file outside the analyzed repository. The SonarQube analysis revision remains separate and `UNVERIFIED`; the local HEAD SHA is context only and is never assigned to imported findings.

## Correction planning

`plan run.json` writes deterministic `quality-audit-kit.plan.json` and `quality-audit-kit.plan.md` artifacts unless explicit output paths are supplied. A lot groups findings only when the findings carry the same explicit common-cause identifier plus evidence/confirmation; shared ownership or similar wording alone never merges findings. Otherwise each finding remains its own lot, preventing redundant fixes without inventing a relation.

The order is explained, not scored: confirmed security, regressions, broken contracts, structural causes, actionable debt, secondary improvements, then uncertain observations. Within a category the plan considers severity, confidence, finding count, known consumers, modification risk, estimated cost and stable lot ID. Missing factors remain `UNKNOWN`. Explicit finding dependencies are resolved to lot dependencies; unknown dependencies and cycles are retained as review blockers.

`plan --next plan.json` returns the highest-priority lot with all predecessors available. It returns `NEEDS_TRIAGE`, `BLOCKED_BY_MEASUREMENT` or `NEEDS_REVIEW` instead of selecting a correction when the evidence is insufficient. `plan --export plan.json --output codex-prompts` writes one autonomous prompt per lot. Prompts include the objective, approved files, findings and provenance, invariants, verification checks and a stop condition. They do not execute Codex, modify source, change a baseline or install dependencies.

Optional planning annotations belong under a finding's `planning` object in the audit-run contract. In particular, `commonCauseId` plus `commonCauseEvidence`/`commonCauseConfirmed` is required for cross-finding grouping; `responsibility`, `category`, `confidence`, `consumers`, `estimatedCost`, `changeRisk` and explicit dependency fields refine the plan without becoming an opaque score.

## Correction workflow

`fix --next plan.json` is read-only by default. It presents the highest-priority ready lot selected by `plan --next`, the generated prompt and the repository-relative file allowlist. It does not modify source files, write a baseline, create a commit or push anything.

Agent execution requires both `--execute` and `--approve`. The default adapter is the locally installed Codex CLI and uses `codex exec --approve-for-me --ephemeral` (the installed CLI maps this approval mode to workspace-write); no Codex binary is installed implicitly and no cloud service is required by Quality Audit Kit. `--agent command --agent-command executable` provides a minimal adapter boundary for another local agent, while `--agent deterministic` is a deterministic test adapter that replaces the `QAK_FIX_ME` fixture marker only.

The agent receives the prompt generated by `plan` plus a bounded allowlist. Pre-existing changes in an approved file block execution. After execution, the workflow audits the Git worktree and rejects out-of-scope changes, deletions and HEAD changes without reverting them. Commits, pushes, baseline changes, policy changes and dependency installation are not performed by the workflow or authorized in the agent prompt.

The workflow re-runs the scanners represented by the lot when local binaries are available, then runs detected safe validation scripts whose names begin with `test`, `check`, `lint`, `typecheck`, `validate` or `verify`. It distinguishes `RESOLVED`, `FAILED`, `BLOCKED` and `UNVERIFIED`: a missing scanner or validation, an unverified dirty-worktree revision, an agent error or a remaining targeted finding never becomes a successful resolution. `--output fix-result.json` preserves a redacted execution journal containing the agent output, scope audit, reanalysis and validation evidence; existing artifacts are not overwritten.

`verify fix-result.json` is read-only. It checks the result contract, redaction boundary, scope audit, targeted reanalysis state and validation outcome. It never runs an agent and never changes the project.

## Threshold recommendations

`thresholds recommend run.json` is a local advisory policy counselor. It consumes explicit `run.metrics` records when available and otherwise derives only `finding_count` series from findings whose engines and findings are `MEASURED`. It never changes the source tree, baseline, decisions or configuration by default.

Each series is separated by metric, language, workspace, file category (`runtime`, `tests`, `configuration`, `generated` or `unknown`) and scope. The JSON and Markdown outputs include count, minimum, maximum, mean, q25, median, q75, q90, q95, IQR outliers, historical-cap exceedances and recommended-target exceedances. The three profiles are explainable: progressive uses q50, balanced uses q25 for lower-is-better metrics (otherwise q50), and strict uses the observed extreme. High quantiles are descriptive only; q90/q95 and high quantiles from a repository marked `DEGRADED` are never promoted to a normative threshold. A degraded series is `REVIEW_REQUIRED`, a generated series is `EXCLUDED_BY_DEFAULT`, and a series with fewer than four observations is `INSUFFICIENT_DATA`.

Every proposal distinguishes `currentMeasurement`, `recommendedObjective` and `historicalRatchetCap`. It also reports justification, affected finding count, confidence and application consequences. Missing, failed or skipped scanners produce warnings and no zero-valued measurements. No global quality score is computed.

`--export file.json` writes an approval-required configuration proposal and does not modify `quality-audit-kit.config.json`. Normative mutation is rejected unless both `--apply` and explicit `--approve` are present. An approved application records the selected profile, source run and `EXPLICIT_CLI_APPROVAL`; it does not raise or silently relax a historical ratchet.

## Contract boundaries

The CLI emits `schemaVersion: 0.1-draft`, `inputScope: WORKTREE_LIVE` and `reproducible: false` for the default live-worktree scan. `commitSha` and `contextCommitSha` record the Git context for compatibility and orientation. Imported reports carry `sourceRevision.status: UNKNOWN` unless a future adapter can demonstrate the analyzed revision. Explicit execution is `VERIFIED` only for a clean worktree represented by HEAD; dirty live worktrees are `UNVERIFIED`. A SHA alone never upgrades a live-worktree run or an imported report to immutable proof.

Finding IDs are SHA-256 fingerprints of the engine, rule, normalized repository-relative path and a stable rule-specific locus. Line movement alone is not part of the fingerprint. jscpd fingerprints include the normalized duplicate pair and available fragment/token information; path moves and scanner-specific changes can still legitimately change an ID.

Package publication, hosted service and automatic remediation remain unimplemented. SARIF and SonarQube connectors are optional and local-first; no account is required by the other commands. Baseline replacement and triage writes are explicit local mutations; scanning itself does not modify analyzed source code.

## References for imported formats

- [Knip reporters](https://knip.dev/features/reporters)
- [jscpd reporters and JSON output](https://github.com/kucherenko/jscpd/blob/master/docs/rust.md)
- [SARIF 2.1.0 OASIS standard](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)
- [SonarQube Web API and bearer authentication](https://docs.sonarsource.com/sonarqube-server/extension-guide/web-api)
