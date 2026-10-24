# Roadmap and release gates

All stages are **planned**, not committed delivery dates.

| Stage | Goal | Exit criterion |
| --- | --- | --- |
| 0. Specification | Publish precise scope and draft formats | Complete for the initial draft contract |
| 1. Engine adapters | Support narrowly selected existing analyzer outputs | First Knip/jscpd adapters delivered; broader fixtures and versions remain |
| 2. Evidence core | Normalize identity, provenance, comparison and triage | Determinism and missing-measurement tests |
| 3. Reporting | JSON, Markdown and offline manifest/bundle | Replayable sample, archive integrity checks |
| 4. Independent validation | Exercise two independent repositories, including one outside CleanMyMap | Local Windows evidence now exists for two repositories; real analyzer diversity, Linux/macOS and known-ground-truth classification remain open |
| 5. CLI npm | Prepare a stable command-line package | Private local tarball, installation/uninstallation smoke test and installation docs are present; registry publication, signing and cross-platform release proof remain open |
| 6. GitHub Actions / SARIF | Optional CI integration and code-scanning output | Manual-only GitHub Actions workflow with `contents: read` is present; remote execution and SARIF consumer compatibility remain open |
| 7. Architecture radar | Correlate hotspots, structural signals and reviewed decisions | Benchmark vs existing dedicated tools and false-positive review |

## Risks and mitigations

- **Fingerprint instability:** compare renamed/moved files, tools versions and shifted lines in fixtures.
- **Evidence laundering:** never coerce failed/skipped/unavailable checks to PASS.
- **False quality assurance:** clearly mark diagnostic coverage gaps and out-of-scope behaviors.
- **Complexity creep:** delay multi-package architecture until real ownership boundaries emerge.
- **Licensing risk:** clean-room implementations if Apache-2.0 is desired; explicit review before reusing AGPL code.
- **Secret leakage:** redact paths, env and raw logs; verify archives before publication.
- **Adoption gap:** test real user problems rather than assuming differentiation.

**Current boundary:** the first CLI is functional for discovery, protected generic template initialization, optional Codex proposal handoff, report import, explicit local execution, historical comparison, baseline replacement with preserved history, evidence-backed triage, configured ratchets, Markdown/JSON rendering and a private local npm tarball. It remains experimental and local-first. The observed evaluation does not claim a hosted service, universal quality gate, registry publication, GitHub Actions success or cross-platform parity.
