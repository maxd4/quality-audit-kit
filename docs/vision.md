# Vision and principles

**Status:** TARGET / DESIGN, not an implemented product.

## Problem

Static analyzers provide diagnostic output, but not necessarily an auditable explanation of how a team governed its accumulated technical debt. Quality reports can be misleading when missing measurements are collapsed into a pass, when baselines become silent suppressions, or when human exceptions outlive the findings that justified them.

## Intended product

A small, local-first, composable governance layer that imports diagnostics from existing engines, tracks their lifecycle and associates human decisions with observable evidence.

It should answer six questions in a reproducible way:

1. What was actually measured, by which engine and against which content?
2. What problems are new, historical, resolved or reintroduced?
3. Which ones require action, and which ones were intentionally retained?
4. What rationale and evidence support each retained exception?
5. Did an attempted correction actually satisfy the relevant acceptance criteria?
6. What remains unknown, unavailable or outside the run's scope?

## Principles

- **No invented evidence:** absent metrics are unknown, never zero or passing.
- **Engine reuse:** integrate mature tools instead of rewriting their scanners.
- **Explicit scope:** distinguish immutable commit snapshots, staged changes and live worktrees.
- **Stable identity:** use documented fingerprints independent of execution identifiers.
- **Ratchets, not amnesty:** protect against new debt without suppressing historical debt from reports.
- **Reviewable exceptions:** justifications must have an owner, reason, provenance and re-review conditions.
- **Local-first outputs:** JSON, Markdown and offline bundles; no mandatory SaaS.
- **Non-destructive defaults:** running or initializing must not silently change host hooks, quality thresholds, baselines or user code.
- **Security by default:** no secrets or private project data in default exports.
- **Pragmatism:** prefer a small useful workflow over a new general static-analysis platform.

## Intended audience

Maintainers of aging codebases, multi-package repositories and teams using automated coding agents, especially when they need to review technical debt and the evidence behind fixes over time.

## Unproven assumptions

- That teams prefer an additional governance layer over existing Qlty/SonarQube workflows.
- That stable fingerprints can generalize across heterogeneous engines without unacceptable churn.
- That offline evidence bundles offer substantial operational value beyond CI artifacts.

These must be tested on independent repositories before distribution is claimed ready.
