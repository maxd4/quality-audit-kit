# Evaluation protocol

**State:** observed partial evidence, Windows-only, 2026-10-24. This report records what was executed; it does not promote the package to a universal quality gate.

## Executed environment

| Item | Observed value |
| --- | --- |
| Host | Windows `win32`, `x64` |
| Node / npm | Node `v24.14.0` / npm `11.9.0` |
| Package distribution | private local tarball, offline consumer install |
| Repositories | this checkout at `067c3fa6`; `ecoandgo` outside CleanMyMap at `5386b17a` |
| Target mutation | the harness compares Git status and SHA-256 snapshots of tracked and non-ignored untracked files; ignored files and external effects remain outside the proof |
| Finding input | the repository SARIF fixture, used identically for both targets |

`ecoandgo` is an independent repository outside CleanMyMap. Its pre-existing dirty worktree was not altered. The common SARIF fixture proves path handling and contract stability across two repository roots; it does **not** prove analyzer diversity, project-specific classification accuracy or a real Knip/jscpd execution on either target.

## Measured results

The reproducible command was:

```text
node tools/measure-workflows.js --target . --target C:\Users\sophi\Desktop\MAXENCE\business\ecoandgo --sarif test\fixtures\sample.sarif --output <temporary-file>
```

| Target | init preview | scan + repeat | report | plan | thresholds | fix preview | verify | output artifacts | peak runner RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| quality-audit-kit | 394.93 ms | 1,173.73 ms | 128.26 ms | 159.99 ms | 164.22 ms | 149.44 ms | 179.95 ms | 62,769 B | 50,084 KiB |
| ecoandgo | 664.32 ms | 1,479.66 ms | 183.07 ms | 157.08 ms | 159.30 ms | 189.91 ms | 226.92 ms | 65,037 B | 50,824 KiB |

Durations are wall-clock process times on one Windows host. Resource values are the parent runner's cumulative CPU/RSS observations and output bytes; child-process peak RSS and full-system utilization are not claimed.

The package smoke test passed in an isolated consumer with network access disabled:

| pack tarball | pack | install | installed `--help` | uninstall | publication |
| ---: | ---: | ---: | --- | ---: | --- |
| 110,722 B | 0.92 s | 1.74 s | PASS | 1.07 s | NOT_RUN |

## Workflow evidence

- `npm run check`: **PASS**.
- `npm test`: **PASS**, 43/43 tests, including stable IDs, incomplete/failed measurements, ratchets, task generation, simulated deterministic corrections, exports, SARIF and SonarQube browser-export contract tests.
- `python tools/validate_examples.py`: **PASS**; the minimal configuration example is checked in addition to the synthetic run and decision fixtures.
- `npm run test:package`: **PASS**; pack, offline install, installed binary help and uninstall were executed. No `npm publish` was run.
- `npm audit --omit=dev --audit-level=high`: **BLOCKED** because this repository intentionally has no lockfile; no registry audit result is claimed. The package has no declared runtime dependencies.
- The two-repository harness produced two findings on each run and `stableIds: true` for both repeated scans. `fix --next` and `verify` returned status 2 because the fixture generated no executable correction lot/evidence; these are expected non-success states, not simulated resolutions.
- Human approval points in the read-only run: `0`. Normative threshold application and correction execution were deliberately not run; the contract still requires `--apply --approve` and `--execute --approve` respectively.
- Confidentiality: the existing export tests passed; they reject unsafe evidence and redact absolute paths. The package smoke test used offline npm operations. No tokens, cookies, localStorage, secrets or service upload were used.

## Classification, platforms and limitations

| Area | Result |
| --- | --- |
| Incorrect NEW/RESOLVED/REINTRODUCED classifications | `NOT_MEASURED`: no independent known-ground-truth corpus was executed. Deterministic fixtures had no unexpected classification in the 43 passing tests. |
| Ratchet mutation on real targets | `NOT_RUN`: the harness only generated threshold proposals and did not apply policy. Ratchet behavior is covered by deterministic tests. |
| Real analyzer diversity | `NOT_PROVEN`: the two-target run imported one SARIF fixture; Knip/jscpd execution on those targets was not claimed. |
| Linux / macOS | `NOT_RUN` locally. The optional Ubuntu Node 18/20 workflow is manual-only and was not dispatched. |
| GitHub / dashboard | `NOT_REQUIRED`, no dashboard or remote upload exists. |
| Human intervention | 0 in the read-only measurement; approval-required mutation paths remain unmeasured here. |

## Method and release boundary

Each run records repository revision, runtime, platform, command durations, output size, finding counts and separate `gitStatusPreserved`, `contentPreserved` and `contentSnapshot` fields. `contentSnapshot` contains file sizes and SHA-256 values for tracked and non-ignored untracked regular files observed through `git ls-files`; ignored files, external effects and temporary effects outside that observed set are `NOT_OBSERVABLE`. An unchanged Git status alone is never treated as content preservation. Essential commands and artifacts must be successful and attributable to the same `runId`; expected status 2 remains visible only for `fix-preview` and `verify`. A future release still requires independent analyzer runs, a known-ground-truth classification corpus, Linux/macOS evidence, a release/signing decision and a manually observed GitHub workflow before those claims can change from `NOT_PROVEN` or `NOT_RUN`.
