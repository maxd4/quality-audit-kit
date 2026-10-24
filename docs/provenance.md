# Origin, observed implementation and extraction boundaries

**Evidence timestamp:** 2026-10-24. **Reference commit:** [`b984d68bf91e864d2242acf07488bdccb8f93431`](https://github.com/maxd4/CleanmyMap/commit/b984d68bf91e864d2242acf07488bdccb8f93431) on `maxd4/CleanmyMap` `main`. This is a **snapshot**, not a permanently current statement.

## Observed in CleanMyMap

- Five primary gates: `dead-code`, `duplication`, `top-heavy`, `complexity`, `cycles`.
- Five auxiliary audits: `maintainability`, `type-safety`, `hotspots`, `testability`, `coverage`.
- Orchestrator: [`scripts/audits/run-quality-audit.mjs`](https://github.com/maxd4/CleanmyMap/blob/b984d68bf91e864d2242acf07488bdccb8f93431/scripts/audits/run-quality-audit.mjs).
- Artifact handling: [`scripts/audits/quality-audit-storage.mjs`](https://github.com/maxd4/CleanmyMap/blob/b984d68bf91e864d2242acf07488bdccb8f93431/scripts/audits/quality-audit-storage.mjs).
- Aggregation and index: [`scripts/reports/quality-file-index.mjs`](https://github.com/maxd4/CleanmyMap/blob/b984d68bf91e864d2242acf07488bdccb8f93431/scripts/reports/quality-file-index.mjs).
- Architecture radar: [`scripts/reports/generate-modularity-radar.mjs`](https://github.com/maxd4/CleanmyMap/blob/b984d68bf91e864d2242acf07488bdccb8f93431/scripts/reports/generate-modularity-radar.mjs).
- The observed runner stores audit reports and manifests by Git SHA and unique runId, using a local artifact root. It records scope/provenance and can aggregate output with offline projections.
- Repository-specific rules, baselines, document paths and policies still bind these scripts to the CleanMyMap workspace.
- A deferred/skipped cycle check must be represented accurately, not silently promoted to a measured pass.

For the source-specific contract see [`scripts/AGENTS.md`](https://github.com/maxd4/CleanmyMap/blob/b984d68bf91e864d2242acf07488bdccb8f93431/scripts/AGENTS.md) and [`documentation/development/testing-quality-audits.md`](https://github.com/maxd4/CleanmyMap/blob/b984d68bf91e864d2242acf07488bdccb8f93431/documentation/development/testing-quality-audits.md).

## What has NOT been established

- No proof these modules run unchanged on an unrelated repository.
- No proof of stable multi-engine fingerprints across versions and path changes.
- No proof this proposed package outperforms Qlty, SonarQube or purpose-built alternatives.
- No evidence of a published npm package or reusable Action from this project.

## Extraction guardrails

This repository contains **no extracted CleanMyMap implementation**. Reuse requires mapping original file provenance, contributors, AGPL license obligations, third-party dependencies and attribution. The independent draft schemas and documentation here were written as new work, not copied implementation. Do not publish real CleanMyMap audit bundles: they may disclose repository topology, logs or sensitive information.

The reference application remains an informative case study and optional future integration, never a mandatory runtime dependency or duplicate source of truth.
