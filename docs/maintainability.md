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
structural adapter. It supports `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.mts` and
`.cts`. The adapter is intentionally conservative: comments and literals are
tokenized, delimiters are balanced, and files with an unmatched delimiter or
unterminated literal are recorded as `FAILURE`; they do not yield zero-valued
measurements. This is a lightweight structural adapter, not a claim of
equivalence with Babel, TypeScript or CodeScene.
TypeScript arrow signatures used only as type aliases, interface members or
annotations are excluded from executable-function measurements; executable
arrows, including annotated arrows and nested callbacks, retain their inferred
identities. Syntax that cannot be classified reliably remains subject to this
lightweight adapter's conservative limits.

For every measured function, the run contains separate records in
`functionMeasurements`:

- `cognitiveComplexity`: decision and nesting points; lower is better;
- `cyclomaticComplexity`: one plus independent decision operators; lower is
  better;
- `functionLength`: inclusive source line span; lower is better.
- `decisionCount`: count of the following decision-bearing AST constructs:
  `if` (including `else if`), `switch`, `case`, `default`, `for` (including
  `for...of` and `for...in`), `while`, `do...while`, `catch`, ternary
  conditions, and each `&&`, `||` or `??` logical operator. `else` alone is
  not a decision and the trailing `while` of a `do...while` is counted only
  once.
- `maxDecisionDepth`: maximum nesting of control-flow decision constructs.
  Sequential decisions at the same level remain at the same depth; `else if`
  chains are treated as the same decision level. Logical and ternary points
  contribute at their enclosing control-flow depth without creating a block
  level by themselves.
- `nestedDecisionCount`: decision points at depth greater than one in the
  containing function.
- `maxSubtreeDecisionCount`: the largest number of decision points in one
  deterministic control-flow subtree, inclusive of its root. The measurement
  also carries `subtreeStartLine`, `subtreeEndLine` and `subtreeRootKind` so
  the concentration can be inspected without rerunning the analyzer.

The four structural metrics are descriptive and are not a second scanner or a
CodeScene-compatible score. They use the same tokenized AST adapter, function
identity, source interval and provenance as the existing complexity metrics.
Nested functions and callbacks are measured independently; their decision
points are excluded from the containing function. A function with no decision
has measured zeros for all four structural metrics. A syntax or parser error
has no fabricated zero measurements and is recorded in coverage as `FAILURE`.

The offline structured report adds `structuralComplexity`, an informative
projection containing only functions with multiple structural signals. It
does not create findings, priorities, thresholds, gate outcomes or automatic
refactoring decisions. Explanations are emitted only when all four structural
values are present and measured.

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
would resolve outside the repository. Discovery failures, including directory
read or physical-path resolution errors, are retained with relative paths in
`errorFiles` and produce a `DISCOVERY_ERROR` diagnostic. They prevent a
`MEASURED` coverage status: a partially measured eligible scope is `PARTIAL`,
and a scope with no usable measurements is `FAILURE`. Voluntary exclusions
remain `SKIPPED_BY_POLICY` and do not become discovery errors.

The optional `--maintainability-report path.json` imports an already generated
canonical report without running the analyzer. The importer validates the
coverage inventory, statuses, counters, function measurement contract and
provenance before accepting it. A `MEASURED` coverage must describe a complete
eligible inventory; a valid complete inventory may nevertheless contain zero
functions. Missing report-level provenance remains `UNKNOWN` and never falls
back to the Git revision of the checkout. The report file and every parent
directory must be physical, regular and inside the repository; symlink or
junction traversal is refused before the file is read.

## Offline historical comparison

Two existing canonical runs can be compared without rerunning any analyzer:

```text
quality-audit-kit trends previous-run.json current-run.json --format json
quality-audit-kit trends previous-run.json current-run.json --format markdown --output trends.md
quality-audit-kit report current-run.json --previous-run previous-run.json --format markdown
```

The comparison requires compatible repository identity, distinct run IDs,
an explicit compatible input scope, a complete `MEASURED`
`maintainabilityCoverage` inventory whose files and function counters agree
with the measurements, a measured maintainability engine, verified source
revisions attributed to both runs, coherent engine versions, and a versioned
definition for every metric being compared. Missing or contradictory coverage,
scope, engine versions or metric definitions make the runs
`NOT_COMPARABLE`; this also applies when both sides omit the same metric
version. A complete measured inventory may still legitimately contain zero
functions.
Function IDs are preferred; a unique path/name/AST-role/language signature is
the only fallback. Renames, ambiguous moves, collisions, incomplete runs and
unverified or unknown provenance remain qualified as `NOT_COMPARABLE`. Added
and removed functions are separate from numeric trends. Missing measurements
are `NOT_MEASURED`; a previous zero yields a null relative delta with an
explicit undefined-zero status. The result is informative only: it does not
change findings, baselines, gates, ratchets or human decisions, and it never
turns a `WORKTREE_LIVE` context SHA into proof of a committed source revision.

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

The corpus size can be adjusted with `QAK_BENCHMARK_FILES=250`. The benchmark
runs the same corpus several times with the original complexity records and
with the structural pass enabled, then reports median elapsed overhead in
milliseconds and percent. Benchmark numbers are environment-dependent; the
JSON output is the evidence to retain when comparing runs.
