# Function maintainability

Quality Audit Kit exposes function-level maintainability as an optional,
informative capability. It is not part of the default scan and it never
changes a historical gate, ratchet, baseline, decision or finding priority.

Run it explicitly:

```text
quality-audit-kit scan . --run=maintainability --output run.json
quality-audit-kit report run.json --format markdown --output report.md
```

The analyzer is dependency-free and uses the versioned `qak-lexical-ast`
adapter. It supports `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.mts` and
`.cts`. The adapter is intentionally conservative: comments and literals are
tokenized, delimiters are balanced, and files with an unmatched delimiter or
unterminated literal are recorded as `FAILURE`; they do not yield zero-valued
measurements. This is a lightweight structural adapter, not a claim of
equivalence with Babel, TypeScript or CodeScene.

For every measured function, the run can contain three separate records in
`functionMeasurements`:

- `cognitiveComplexity`: decision and nesting points; lower is better;
- `cyclomaticComplexity`: one plus independent decision operators; lower is
  better;
- `functionLength`: inclusive source line span; lower is better.

Each record carries the engine and metric versions, language, relative path,
versioned function identity, inferred structural role, start and end lines,
status, source revision, content hash and an evidence reference. A simple
function therefore has cognitive complexity `0`, while its cyclomatic
complexity remains `1`; zero is a measured value, not a missing measurement.

`maintainabilityCoverage` is the explicit inventory. It records eligible,
measured, policy-excluded, unsupported and error files, the number of distinct
functions measured, and the parser engine/version actually used. Default
exclusions include dependencies, generated/build artifacts, Git-ignored files,
and symbolic links. Symbolic links are not followed, including links that
would resolve outside the repository.

The optional `--maintainability-report path.json` imports an already generated
canonical report without running the analyzer. The imported file must contain
`functionMeasurements` and `maintainabilityCoverage`.

## Optional-adapter behavior

The module API accepts an adapter allowlist. If no compatible local adapter is
available, it returns `NOT_MEASURED` with the exact reason that no compatible
local parser was available. The CLI never installs a dependency or contacts a
network service.

## Reproducible synthetic benchmark

The benchmark creates a temporary deterministic corpus, measures it, reports
elapsed cost, eligible/measured file counts and function counts, and removes
the corpus:

```text
npm run benchmark:maintainability
```

The corpus size can be adjusted with `QAK_BENCHMARK_FILES=250`. Benchmark
numbers are environment-dependent; the JSON output is the evidence to retain
when comparing runs.
