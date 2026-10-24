# Initialization templates

**Status:** EXPERIMENTAL, implemented locally and covered by CLI integration tests.

`quality-audit-kit init` creates two repository-local Markdown documents when they do not already exist:

- `PROJECT_HANDOFF.md` — detected repository facts plus protected user-maintained context for purpose, architecture, sources of truth, state and decisions.
- `COMMIT_REVIEW.md` — generic review protocol plus detected controls and protected repository-specific review decisions.

The templates are deliberately generic. They do not copy product, identity, database, deployment or governance rules from any source repository. The generated sections contain only bounded observations such as detected paths, package metadata, scanner configuration and Git state. Claims that require reading or understanding the real code remain `UNKNOWN` until an agent or user demonstrates them.

## Managed blocks

Each file contains exactly one `QAK:BEGIN GENERATED` / `QAK:END GENERATED` block and one `QAK:BEGIN MANUAL` / `QAK:END MANUAL` block. The manual block contains a nested `USER_DECISIONS` block in `PROJECT_HANDOFF.md`.

- A normal `init` never overwrites an existing template.
- `init --update-templates` replaces only the generated block.
- Manual text and user decisions are preserved byte-for-byte.
- An existing document without valid QAK markers is `BLOCKED` and is not modified.
- `init --update-templates --preview` returns a deterministic diff preview and performs no mutation.

`context refresh` is the fact-only update path. It replaces only `DETECTED_FACTS` in `PROJECT_HANDOFF.md` and `DETECTED_CONTROLS` in `COMMIT_REVIEW.md`; the generic protocol, instructions, manual context and decisions remain unchanged. It reports changed fields and exits with status 2 when an explicit human field contradicts a newly detected fact. In that case both the human decision and the observed value are retained.

`setup` composes the same protected initialization with an optional explicit answers file. It never asks an AI provider to write implicitly: an agent or human must inspect the real repository and provide `projectHandoffGenerated` and/or `commitReviewGenerated`, then resume with `setup --resume state.json --answers answers.json`. The setup state records whether personalization was applied, what remains unknown and which questions require a second pass.

If one of the documents does not exist, the command returns `NOT_INITIALIZED` instead of treating missing context as up to date; run `init` explicitly.

## Optional Codex handoff

`init --agent codex --agent-prompt .qak-codex-request.md` writes a local prompt describing the files to inspect. The CLI does not execute an agent, call a web service or install dependencies. A user may explicitly provide a Codex proposal with:

```json
{
  "projectHandoffGenerated": "## Observed facts\n\n- FACT: ...",
  "commitReviewGenerated": "## Observed controls\n\n- FACT: ..."
}
```

Apply it only with `init --agent codex --agent-input proposal.json --update-templates`. The CLI accepts generated-block content only, rejects QAK marker injection and rejects secret-like values. It never claims that the proposal was independently validated.

## Optional AGENTS.md link

`--link-agents` is opt-in. If a root `AGENTS.md` exists, the command appends or refreshes one bounded link block. It does not create `AGENTS.md`, rewrite existing governance or add a link during a normal initialization.
