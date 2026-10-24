---
name: quality-audit-kit-setup
description: Use when a user asks an AI agent to install, initialize, configure, audit, or resume Quality Audit Kit in a repository. This skill covers repository discovery, protected setup, PROJECT_HANDOFF.md and COMMIT_REVIEW.md personalization, local audit, evidence reporting, human questions, and COMPLETE/PARTIAL/BLOCKED handoff. Do not use it for generic code review or for applying fixes without explicit approval.
---

# Quality Audit Kit setup

Use this workflow when the user wants Quality Audit Kit installed and configured from a natural-language request. The CLI is deterministic and remains usable without an AI provider; the agent supplies only the repository inspection and, when explicitly confirmed, the generated-block answers.

## Safety boundary

- Discover the target repository before writing anything. Keep the exact root and file paths in the final handoff.
- Use the current GitHub checkout or an already available local checkout. The package is private and is not installed from npm.
- Do not install analyzers, dependencies, browser extensions or services. Do not contact SonarQube or another network service during setup.
- Do not modify application source, Git state, remotes, baselines, thresholds or existing project instructions.
- `PROJECT_HANDOFF.md`, `COMMIT_REVIEW.md`, `AGENTS.md` and other governance files are protected. Existing managed documents may be refreshed only through the explicit `--answers` path; unmanaged or malformed documents must remain unchanged. A default setup may continue as `PARTIAL`; an explicit personalization attempt against an unmanaged document must produce `BLOCKED`.
- Never include cookies, tokens, credentials, secrets or secret-like values in an answers file, report, state file or response.
- Run scanners only when the user explicitly authorizes execution and only when their binaries already exist in the target repository. Otherwise import existing local reports or record `NOT_MEASURED`.

## Workflow

1. Discover the target root, package manager, workspaces, source languages, project files, governance files and locally available scanners. Treat observations as facts only; keep unknowns as `UNKNOWN`.
2. Obtain Quality Audit Kit from the current GitHub repository if no local checkout is available:

   ```text
   https://github.com/maxd4/quality-audit-kit
   ```

   Use `node bin/quality-audit-kit.js` from that checkout. Do not run `npm install` or `npm publish`.
3. Run setup in the target repository. The default is offline and does not execute scanners:

   ```bash
   node /path/to/quality-audit-kit/bin/quality-audit-kit.js setup /path/to/target-repository
   ```

   The command delegates to the existing `init`, `scan` and `report` implementations. It creates or reuses a configuration, protected generic templates, `quality-audit-kit.setup.run.json`, `quality-audit-kit.setup.report.md` and the resumable `quality-audit-kit.setup.json` state. It does not overwrite an existing setup state; use `--resume` for a second pass. The state records the selected run, report association, freshness and preserved artifacts.
4. Read the generated `PROJECT_HANDOFF.md`, `COMMIT_REVIEW.md`, the setup state and the real repository sources listed by discovery. Do not infer purpose, authority, security, deployment or test guarantees from filenames alone.
5. If semantic personalization is needed, prepare a local JSON file containing only the generated blocks that are supported by direct evidence:

   ```json
   {
     "projectHandoffGenerated": "## Evidence-backed project context\n\n- Purpose: ...",
     "commitReviewGenerated": "## Evidence-backed review controls\n\n- Review control: ..."
   }
   ```

   Do not include `QAK:` marker lines. Use `UNKNOWN` instead of filling a gap. Apply it only with:

   ```bash
   node /path/to/quality-audit-kit/bin/quality-audit-kit.js setup \
     --resume /path/to/target-repository/quality-audit-kit.setup.json \
     --answers /path/to/setup-answers.json
   ```

   The CLI validates marker injection and secret-like values, replaces only the managed generated blocks, and preserves manual decisions byte-for-byte.
6. If the user explicitly authorizes local scanner execution, resume with `--run` or `--run=knip,jscpd`. This is not an installation flag:

   ```bash
   node /path/to/quality-audit-kit/bin/quality-audit-kit.js setup \
     --resume /path/to/target-repository/quality-audit-kit.setup.json \
     --run=knip,jscpd
   ```

   If reports or scanners are absent, continue and report the affected capability as unavailable. Never substitute another tool or claim a clean result.
7. On every pass, read the structured state and report the result. A resumed pass without `--run` may reuse a run only after the canonical contract, repository attribution, provenance and freshness checks pass; it may reuse a report only when its content is associated with that exact `runId`. An explicit `--run` is an authorization for a new scan: it never reuses the old run, preserves old run/report files, selects non-existing artifact paths and records the new run/report association. It must not reinstall dependencies or contact a service. Ask only the precise questions still present in `state.questions`.

## Handoff contract

The state file follows [`schemas/setup-state.schema.json`](../../schemas/setup-state.schema.json). The final response must contain:

- every created, changed or reused file with its absolute path;
- every command actually executed, its observed status and the relevant result;
- activated, unavailable and unverified capabilities;
- missing information and human actions still required;
- the precise questions for the next pass;
- exactly one final state: `COMPLETE`, `PARTIAL` or `BLOCKED`.

Use these meanings:

- `COMPLETE`: initialization, personalization, a valid measured audit with demonstrated current/relevant freshness, and a Markdown report associated with that exact run are all evidenced.
- `PARTIAL`: setup and report completed, but personalization, scanner evidence or another non-blocking capability remains unavailable or unverified.
- `BLOCKED`: a protected file, invalid answer, unsafe path, permission boundary or contract error prevented a required step.

Do not promote `PARTIAL` or `BLOCKED` to success because templates were created. A generated declaration is not proof of a test, confinement, security property or deployment behavior.

## Examples

### Happy path

The repository contains valid local Knip and jscpd reports. Run `setup`, inspect the real sources, apply an evidence-backed answers JSON with `--resume --answers`, and report `COMPLETE` only if both imported engines are `MEASURED` and the report was written.

### No scanner or network

Run setup without `--run`. Preserve `NOT_MEASURED` engines, write the Markdown report, list scanner evidence as unavailable, and return `PARTIAL`. Do not probe a remote service or install a scanner to improve the status.

### Existing instructions

If `AGENTS.md` already exists, leave its bytes unchanged. If either QAK document exists but lacks valid managed markers, leave it unchanged and keep the default setup `PARTIAL`; if an explicit answers pass tries to update it, return `BLOCKED` with its exact path and a question for the maintainer.

### Anti-pattern and correction

Bad: run `npm install`, invent a purpose from the repository name, overwrite `AGENTS.md`, or call a successful `init` a complete audit.

Correct: use the local GitHub checkout, run deterministic setup offline, preserve unknowns, request explicit answers, reuse state with `--resume`, and report observed evidence separately from declarations.
