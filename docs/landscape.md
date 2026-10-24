# Ecosystem and positioning

**Research snapshot:** 2026-10-24. Capabilities, editions and licenses may change. Verify upstream before claims about compatibility or distribution.

| Tool | Established coverage | Where Quality Audit Kit proposes additional value |
| --- | --- | --- |
| [Qlty CLI](https://github.com/qltysh/qlty) | Multiple analysis engines, linting, maintainability, quality workflows, PR feedback | Explicit per-run proof model and versioned exception lifecycle, if independent validation demonstrates a useful difference |
| [SonarQube Community Build](https://github.com/SonarSource/sonarqube) | Static analysis, defects, quality gates and historical comparison | Lightweight offline records and repository-owned triage workflow, not a replacement for its analysis engine |
| [MegaLinter](https://github.com/oxsecurity/megalinter) | Orchestration of numerous language-specific linters and CI execution | Durable adjudication and evidence traceability across runs |
| [CodeScene](https://codescene.io/) | Git-history-driven hotspots and code-health analysis | Human decisions associated with explicit findings and evidence states |
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | JavaScript/TypeScript import policies and dependency graphs | Potential input adapter for a later architectural domain |
| [Semgrep](https://github.com/semgrep/semgrep) | Customizable static and security analysis | Findings importer, not substitute rule engine |
| [reviewdog](https://github.com/reviewdog/reviewdog) | Display diagnostics in code review | Longitudinal triage and offline records |

Qlty is publicly distributed under **Business Source License 1.1 / Fair Source**, with a delayed open-source transition according to its repository. Sonar describes Community Build source without bundled analyzers as LGPLv3; some bundled analyzers use its Source-Available license. Avoid the simplistic claim that *all* SonarQube assets are uniformly open-source.

## Comparison by capability

| Capability | Landscape assessment | Proposed emphasis |
| --- | --- | --- |
| Dead code, duplication, complexity | Mature engine solutions exist | Reuse and normalize their output |
| Quality gates and baselines | Common practice | Explicit historical/new/reintroduced states |
| Offline, revision-linked evidence | Depends on product and edition | Mandatory run provenance and missing-evidence semantics |
| Justification tracking | Exists in various forms | Typed decisions, stale detection and review evidence |
| Architecture hotspot prioritization | Specialized products exist | Later optional composition, never inferred from file size alone |
| Exhaustive historical-debt review | Workflow-dependent | Make untriaged historical findings visible |

**Differentiation is currently a hypothesis, not a demonstrated innovation.** Avoid generic promises such as "better than SonarQube" or "the first tool".

## Primary references

- Qlty license and features: https://github.com/qltysh/qlty
- Sonar licensing notes: https://www.sonarsource.com/license/
- SonarQube source: https://github.com/SonarSource/sonarqube
- MegaLinter: https://github.com/oxsecurity/megalinter
- CodeScene: https://codescene.io/
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser
- Semgrep: https://github.com/semgrep/semgrep
- reviewdog: https://github.com/reviewdog/reviewdog
