# Proposed architecture

**Status:** EXPERIMENTAL SKELETON. The CLI runner, discovery, normalizers and report renderer are implemented; broader package boundaries remain target architecture.

```text
quality-audit-kit/
  bin/                    # portable Node.js entry point
  src/                    # discovery, scanner adapters, normalization, reports
  test/                   # dependency-free Node.js integration tests
  packages/
    core/                   # findings, evidence, baselines, triage, policies
    cli/                    # argument parsing and orchestration
    adapters/               # knip, jscpd, eslint, others as demand proves
    reporters/              # JSON, Markdown, offline; later SARIF
  examples/
  schemas/
  docs/
  .github/workflows/
```

The initial repository contains only documentation, schemas, fictional fixtures and checks. Create packages when a working boundary is justified; do not scaffold empty implementations.

## Flow and ownership

1. **Runner** records Git revision, input scope, engine invocation and run identifier.
2. **Adapters** translate original engine records to a normalized schema, retaining source information.
3. **Core** calculates fingerprint, baseline differences and policy outcomes.
4. **Triage** links explicit, time-bounded human decisions to stable finding IDs.
5. **Reporter** emits JSON and Markdown; a separate bundler creates verifiable offline archives.
6. **Optional CI facade** enforces a clearly scoped gate without mutating policy or baseline.

## Boundary design

| Responsibility | Canonical future owner | Must never do |
| --- | --- | --- |
| External command execution | CLI runner | Treat invocation failure as passing |
| Source parser | Engine adapter | Silently drop unknown original fields |
| Identity/fingerprint | Core findings module | Use runId as issue identity |
| Baseline classification | Core baselines module | Discard historical actionable findings |
| Exception validation | Core triage module | Accept stale decisions silently |
| Revision/proof contract | Core evidence module | Claim a live worktree is an immutable SHA snapshot |
| Serialization | Reporters | Alter findings while formatting them |

## Scope and trust model

`COMMITTED_SNAPSHOT`, `STAGED`, and `WORKTREE_LIVE` are distinct input scopes. `COMMITTED_SNAPSHOT` must be backed by the exact Git object and any required source materialization. `STAGED` represents index content, including when it differs from HEAD. `WORKTREE_LIVE` is mutable and never has immutable-SHA proof by itself. A CI run should describe the candidate it actually checked.

Engine state and policy outcome are orthogonal: `SKIPPED_BY_POLICY` cannot be transformed into `PASS`; an engine failure cannot be represented as an empty findings list. A report must preserve raw diagnostic references alongside normalized data.

## Architecture choices deliberately deferred

- Language-specific AST analysis.
- A persistent central service or database.
- Hosted dashboards or agent-driven code modification.
- Mandatory Git hooks or PR mutation.
- SARIF until a compliant mapping is demonstrated.
- Multi-language claim until at least two different ecosystems are tested.
