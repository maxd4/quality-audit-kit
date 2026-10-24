# Draft contracts

**Status:** DESIGN v0.1. These are proposals, not stable public APIs or implementations.

JSON Schema draft 2020-12 is used for machine-readable shape constraints. The provided Python test harness performs additional basic cross-file checks but is **not** a full JSON Schema implementation.

## Run identity

A run has `schemaVersion`, a unique `runId`, a `repository` context, an `inputScope`, an optional audited commit, discovery metadata and recorded engines. Reproducibility is a claim that requires proof and must not be inferred merely because a SHA string is present.

## Engine status vs run result

| Engine `measurementStatus` | Meaning | Implication |
| --- | --- | --- |
| `MEASURED` | Engine produced usable measurement | Findings may be zero if this is explicit |
| `PARTIAL` | Some results were imported, but a configured limit, page failure or required metadata prevented completeness | Findings are retained as partial evidence; never infer absence or comparability |
| `NOT_MEASURED` | No reliable measurement produced | Do not infer no problems |
| `FAILURE` | Attempted execution failed | Preserve failure details |
| `SKIPPED_BY_POLICY` | Deliberately not executed | Record policy reason |

`gateOutcome` is separate: `PASS`, `FAIL`, `INFORMATIVE` or `NOT_EVALUATED`. A check that was not measured cannot establish `PASS`.

## Finding contract

Each finding has:

- `id`: deterministic, namespaced fingerprint from stable canonical input;
- `engine`, `ruleId`, `path`, `severity`, `message`;
- `lifecycle`: `UNCLASSIFIED` until a baseline/comparison qualifies the finding, then `NEW`, `HISTORICAL_ACTIONABLE`, `HISTORICAL_JUSTIFIED`, `RESOLVED` or `REINTRODUCED`;
- `measurementStatus`: the engine evidence state for this finding;
- `provenance`: whether the finding came from an imported report or an explicit scanner execution, with a report/command reference and optional source-revision evidence;
- source location and an optional `rawReference` to recover original evidence;
- optional original engine fingerprint, never assumed globally unique.

Proposed fingerprint input: `engine + ruleId + normalized repo-relative path + stable rule-specific locus`. This needs testing against path moves, renames, line shifts, duplicate findings and scanner version updates. Path-only fingerprints are insufficient; commit SHA must **not** be part of stable identity.

`RESOLVED` means absent in a comparable completed measurement, **not** absent when the engine did not run.

## Human decision contract

## Optional connector contract

SARIF 2.1.0 is a local interchange connector. Import maps `tool.driver.name`/version, `result.ruleId`, the first representable physical location, `result.level`, message, a stable GUID/fingerprint locus and a `sarif://` raw reference to the canonical finding. Lifecycle remains `UNCLASSIFIED` until history qualifies it. SARIF fields such as code flows, fixes, related locations and missing repository-relative locations are retained as explicit run diagnostics; source `revisionId` is `UNVERIFIED` unless a separate process proves local content equivalence. Export reverses this mapping and carries Quality Audit Kit fields under SARIF `properties`.

SonarQube import is opt-in and uses the official Web API: `/api/server/version`, `/api/issues/search` and `/api/project_analyses/search`. Project, branch or pull-request selector, API version, pagination limit and analysis revision are recorded. A Sonar analysis revision is independent from the local Git context SHA and is never replaced with `HEAD`; absent or non-demonstrable revision evidence is `UNKNOWN`. Token material is read from an environment variable or a file outside the repository and is excluded from runs, logs and bundles. HTTP permission errors, page failures and result limits remain `FAILURE`/`PARTIAL` diagnostics rather than clean measurements.

A decision identifies the exact finding and, for the current CLI, one of `FIX`, `DEFER`, `KEEP_JUSTIFIED` or `FALSE_POSITIVE`, with a reason, reviewer attribution, reviewed revision, evidence links and optionally an expiration/re-review condition. The schema retains older draft values for compatibility with prior examples, but the new CLI does not create them. An exact classification in CleanMyMap is not a universally appropriate future policy; these generic values remain repository-owned.

A justified exception must become `STALE` if its finding disappears, its scope changes unexpectedly, or its review conditions are no longer satisfied. Stale does not automatically mean fixed or safe.

## Evidence levels

| Evidence kind | What it proves |
| --- | --- |
| `SOURCE_INSPECTION` | A source or configuration property was checked |
| `STATIC_CONTRACT` | A static structural check passed its scoped assertion |
| `EXECUTED_BEHAVIOR` | Application or unit code actually executed in a test harness |
| `INTEGRATION_PROOF` | A real external or persistent boundary was exercised |
| `UNKNOWN` | Insufficient or unavailable evidence |

Evidence must carry its producer, scope, revision or artifact reference and outcome. A static SQL text assertion does not prove RLS behavior. CI green is not universal proof of correctness.

## Baselines and gate invariants

- A baseline is a versioned classification reference, never a wholesale ignore list.
- A baseline update is an explicit reviewed operation, separate from analysis.
- New/reintroduced findings can be gated; historical ones remain reportable and triageable.
- A missing engine result leaves comparison `NOT_EVALUATED`, not `RESOLVED`.
- Ratchet exceptions have a rationale and bounded review conditions.
- A first observation without a comparison remains `UNCLASSIFIED`; `NEW` requires an actual comparison against a qualifying baseline or history.
- The repository `commitSha`/`contextCommitSha` identifies Git context, not automatically the revision analyzed by an imported report. Each engine measurement carries independent `sourceRevision` evidence with `VERIFIED`, `UNVERIFIED` or `UNKNOWN` status.
- A valid JSON payload from a failed scanner process is not a complete measurement unless the exit code is an expected findings/threshold code for that scanner.

## Historical comparison

`baseline` stores a complete measured audit run plus a `QUALITY_BASELINE` block. Replacing it with `--replace` appends the former baseline and its prior history as immutable run snapshots. The snapshots retain finding IDs, provenance, engine status and source-revision evidence so a later complete run can identify a reintroduction without treating an incomplete run as a resolution.

Two runs are comparable only when their schema version, repository name, input scope and measured engine set agree, every engine is `MEASURED` and every engine/finding source revision is `VERIFIED`. Imported reports with `UNKNOWN` source revision, missing scanners, failed scanners and `NOT_EVALUATED` engines are not comparable. Exact IDs handle line moves. A unique message-based comparison key may correlate a file move; ambiguous matches are deliberately not inferred.

The comparison output is evidence, not a baseline mutation. It records matches, resolved baseline findings, stale decisions and the quality-gate result in the run. `NEW` and `REINTRODUCED` are the only lifecycle states considered new temporal debt; a valid `KEEP_JUSTIFIED` or `FALSE_POSITIVE` decision can keep a historical finding justified, while `FIX` and `DEFER` remain actionable. A stale decision is never used to justify a gate.

## Decisions and ratchets

The existing triage decision schema remains the decision evidence contract. The public CLI accepts `FIX`, `DEFER`, `KEEP_JUSTIFIED` and `FALSE_POSITIVE`; it preserves prior records and appends a new decision rather than rewriting the evidence bundle. Every decision includes a reason, reviewer, reviewed Git revision and one or more evidence records. A passed `reviewAfter`, disappearance of a justified/actionable finding, or a changed file scope marks the latest decision `STALE`.

The configured ratchet defaults to zero new `HIGH`/`CRITICAL` findings. `maxNewBlockingFindings` and optional `maxMeasuredFindings` are ceilings. Increasing a ceiling, removing a blocking severity or making a finite ceiling unlimited is a policy relaxation and fails the gate. A measured reduction may produce a `STRICTER_CEILING` proposal with `EXPLICIT_REVIEW_REQUIRED`; no baseline, decision or policy is changed implicitly.

## Threshold recommendations

An optional run-level `metrics` array carries numeric measurements with `name`, `unit`, `status`, optional repeated `values`, direction (`LOWER_IS_BETTER` or `HIGHER_IS_BETTER`), language, workspace, file category and finding count. The `thresholds recommend` command groups explicit measurements, or derives only measured finding counts when no explicit metrics are available. It reports descriptive quantiles and extremes, but recommendation formulas use only q50, q25 or an observed extreme; q90/q95 are never normative inputs. Failed, skipped or unavailable measurements remain warnings, and absent measurements are not zero.

Each proposal has separate current measurement, recommended objective and historical ratchet cap fields. Generated files are excluded by default, degraded series require review, and fewer than four observations are insufficient. Exported proposals always carry `approvalRequired`; only an explicit `--apply --approve` operation can modify normative thresholds.

## Draft files

- [`audit-run.schema.json`](../schemas/audit-run.schema.json)
- [`triage-decision.schema.json`](../schemas/triage-decision.schema.json)
- [`plan.schema.json`](../schemas/plan.schema.json)
- [`threshold-recommendation.schema.json`](../schemas/threshold-recommendation.schema.json)
- [`fix-result.schema.json`](../schemas/fix-result.schema.json)
- [Synthetic run](../examples/run.example.json)
- [Synthetic decisions](../examples/decisions.example.json)

## Data privacy and export

Reporters must be able to redact absolute paths, user identities, tokens, environment values and private source excerpts. Offline bundles require an explicit inventory and must not silently include raw files, full source trees or credential-bearing command logs.
