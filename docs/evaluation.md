# Evaluation protocol

**State:** planned experiments, no measurements reported yet.

## Test repositories

Use two unrelated real projects under permissions that allow analysis, at least one outside the CleanMyMap organization and preferably differing in size and architecture. Do not use synthetic fixtures as the sole proof of generality.

## Measurements

- Time to install, configure and execute on Windows, Linux and macOS where supported.
- Time and resource consumption on comparable fixed revisions.
- Parser coverage and number of unsupported engine diagnostics.
- Stable ID churn between line shifts, path changes and engine upgrades.
- Incorrect NEW, RESOLVED or REINTRODUCED classifications with known ground truth.
- Stale triage detection precision and false positives.
- Bundle validation success, missing evidence states and reproducibility from pinned inputs.
- Secret/data exposure checks on exports.
- Maintainer feedback: proportion of findings with an actionable disposition and perceived added value vs existing tools.

## Method

Record revision, engine versions, OS/runtime, input scope, dataset fixture and runId for each run. Separate observation from opinion. Compare to the pre-existing quality workflow, rather than assuming improvements from richer reports. Report unknowns and failures even when inconvenient.

## Pass/fail criteria

The first real release requires independent reproducibility, complete negative tests for skipped/failed engines, and no project-path customization. Adoption benefit and benchmarking remain `NOT_PROVEN` until observed.
