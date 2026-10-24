# MVP product specification

**Status:** IN PROGRESS / EXPERIMENTAL. The first local CLI, protected project templates and the initial Knip/jscpd report adapters are delivered; the full MVP is not.

## Intended initial product

A local-first tool for JS/TS repositories that imports existing scanner outputs and relates them to revisions, baselines, human decisions and reviewable reports. It must be useful without CleanMyMap and without a hosted account.

### P0 user stories

1. Import a valid Knip output and a jscpd output from a fresh repository with explicit adapter versions.
2. Store stable findings and raw references; reject invalid or unsupported shapes with a meaningful error.
3. Compare two **comparable, measured** runs to classify NEW, historical, resolved and reintroduced issues.
4. Associate reviewed justifications and flag orphaned/stale decisions.
5. Preserve SHA, input scope, run ID, tool versions and measurement states.
6. Generate a deterministic machine JSON report and a concise Markdown report.
7. Produce an offline archive with manifest and checksums; verify that the archive corresponds to one run and report.
8. Run safely without modifying repository code, hooks, baselines, or working files, except explicit output locations.

### Non-goals for initial delivery

- A full replacement scanner or automatic refactoring agent.
- Broad language support by assertion alone.
- Public npm package until independent adoption tests pass.
- GitHub Action, SARIF and hosted service as MVP blockers.
- Autonomous acceptance or deletion of findings based solely on an AI suggestion.

## Local CLI prototype

```text
quality-audit-kit init
quality-audit-kit scan
quality-audit-kit report
```

`init` writes an explicit local configuration and deterministic `PROJECT_HANDOFF.md` / `COMMIT_REVIEW.md` templates. It can prepare an explicit Codex customization request and refresh only managed generated blocks. `scan` is read-only toward source and policy, imports existing Knip/jscpd JSON reports and can execute locally installed binaries only when `--run` is explicit. `baseline` creates an explicit measured-run baseline, `triage` appends evidence-backed decisions and reports stale decisions, and `scan --baseline` applies a configured ratchet without mutating the baseline automatically. `report` formats existing recorded evidence. These capabilities remain experimental and local-first.

## Acceptance criteria

- Demonstrate two completely independent repositories, at least one **not** CleanMyMap, with zero project-specific path hacks.
- Re-running the same inputs produces the same issue identities and normalized report data (excluding explicit execution metadata).
- Existing/new/resolved/reintroduced classes are tested, including scanner failure and unmeasured states.
- A justified historical finding remains visible; stale justification is detected.
- Two simultaneous runs cannot silently overwrite one another's output.
- An interrupted run cannot be mistaken for a completed proof.
- Report provenance clearly distinguishes live worktree from commit snapshot.
- No secret or source tree included in an export by default.
- Installation and removal leave user hooks and dependencies unchanged.
