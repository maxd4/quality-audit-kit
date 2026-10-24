# Roadmap and release gates

All stages are **planned**, not committed delivery dates.

| Stage | Goal | Exit criterion |
| --- | --- | --- |
| 0. Specification | Publish precise scope and draft formats | Documents reviewed, synthetic samples consistent, license/provenance clean |
| 1. Engine adapters | Support narrowly selected existing analyzer outputs | Real fixtures, parser error paths, no false empty results |
| 2. Evidence core | Normalize identity, provenance, comparison and triage | Determinism and missing-measurement tests |
| 3. Reporting | JSON, Markdown and offline manifest/bundle | Replayable sample, archive integrity checks |
| 4. Independent validation | Exercise two external repositories | No CleanMyMap-specific config required; issues and changes documented |
| 5. CLI npm | Publish a stable command-line package | Cross-platform smoke tests, installation documentation, semver contract |
| 6. GitHub Actions / SARIF | Optional CI integration and code-scanning output | Explicit auth/security permissions, supported SARIF semantics |
| 7. Architecture radar | Correlate hotspots, structural signals and reviewed decisions | Benchmark vs existing dedicated tools and false-positive review |

## Risks and mitigations

- **Fingerprint instability:** compare renamed/moved files, tools versions and shifted lines in fixtures.
- **Evidence laundering:** never coerce failed/skipped/unavailable checks to PASS.
- **False quality assurance:** clearly mark diagnostic coverage gaps and out-of-scope behaviors.
- **Complexity creep:** delay multi-package architecture until real ownership boundaries emerge.
- **Licensing risk:** clean-room implementations if Apache-2.0 is desired; explicit review before reusing AGPL code.
- **Secret leakage:** redact paths, env and raw logs; verify archives before publication.
- **Adoption gap:** test real user problems rather than assuming differentiation.

**STOP CONDITION for this initial repository:** comprehensive truthful documentation, coherent draft schemas/examples, no proprietary or CleanMyMap runtime material imported. No demand for a fictional functioning CLI.
