# Draft contracts

**Status:** DESIGN v0.1. These are proposals, not stable public APIs or implementations.

JSON Schema draft 2020-12 is used for machine-readable shape constraints. The provided Python test harness performs additional basic cross-file checks but is **not** a full JSON Schema implementation.

## Run identity

A run has `schemaVersion`, a unique `runId`, a `repository` context, an `inputScope`, an optional audited commit, discovery metadata and recorded engines. Reproducibility is a claim that requires proof and must not be inferred merely because a SHA string is present.

## Engine status vs run result

| Engine `measurementStatus` | Meaning | Implication |
| --- | --- | --- |
| `MEASURED` | Engine produced usable measurement | Findings may be zero if this is explicit |
| `NOT_MEASURED` | No reliable measurement produced | Do not infer no problems |
| `FAILURE` | Attempted execution failed | Preserve failure details |
| `SKIPPED_BY_POLICY` | Deliberately not executed | Record policy reason |

`gateOutcome` is separate: `PASS`, `FAIL`, `INFORMATIVE` or `NOT_EVALUATED`. A check that was not measured cannot establish `PASS`.

## Finding contract

Each finding has:

- `id`: deterministic, namespaced fingerprint from stable canonical input;
- `engine`, `ruleId`, `path`, `severity`, `message`;
- `lifecycle`: `NEW`, `HISTORICAL_ACTIONABLE`, `HISTORICAL_JUSTIFIED`, `RESOLVED` or `REINTRODUCED`;
- `measurementStatus`: the engine evidence state for this finding;
- `provenance`: whether the finding came from an imported report or an explicit scanner execution, with a report/command reference;
- source location and an optional `rawReference` to recover original evidence;
- optional original engine fingerprint, never assumed globally unique.

Proposed fingerprint input: `engine + ruleId + normalized repo-relative path + stable rule-specific locus`. This needs testing against path moves, renames, line shifts, duplicate findings and scanner version updates. Path-only fingerprints are insufficient; commit SHA must **not** be part of stable identity.

`RESOLVED` means absent in a comparable completed measurement, **not** absent when the engine did not run.

## Human decision contract

A decision identifies the exact finding and one of `FIX`, `MIGRATE`, `INTERNALIZE`, `RESTORE_FUNCTIONALITY`, `KEEP_JUSTIFIED`, `DEFER` or `FALSE_POSITIVE`, with a reason, reviewer attribution, reviewed revision, evidence links and optionally an expiration/re-review condition. An exact classification in CleanMyMap is not necessarily a universally appropriate future policy; the values are a draft extension point.

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
- No new finding can be granted historical status merely to pass a gate.

## Draft files

- [`audit-run.schema.json`](../schemas/audit-run.schema.json)
- [`triage-decision.schema.json`](../schemas/triage-decision.schema.json)
- [Synthetic run](../examples/run.example.json)
- [Synthetic decisions](../examples/decisions.example.json)

## Data privacy and export

Reporters must be able to redact absolute paths, user identities, tokens, environment values and private source excerpts. Offline bundles require an explicit inventory and must not silently include raw files, full source trees or credential-bearing command logs.
