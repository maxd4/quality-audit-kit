# Publication checklist

**Status:** no remote repository is created by these files alone.

Target: new `maxd4/quality-audit-kit` public repository, default branch `main`.

1. Confirm that the repository name is still available and GitHub account access is correct.
2. Review LICENSE/NOTICE, docs, schemas and all examples for confidential material and rights.
3. Publish these exact files as the initial content of a **new**, independent GitHub repository. Do not change `maxd4/CleanmyMap`.
4. Protect `main` and enable Dependabot, secret scanning/security alerts and private vulnerability reporting where available.
5. Run `python3 tools/validate_examples.py` and verify the published tree/CI checks.
6. Mark the repository's description as **experimental**, without claiming npm availability or working scanner integrations.

Recommended GitHub description:

> Evidence-driven software quality governance: track findings, baselines, human decisions and reproducible audit evidence. Experimental specification.

Suggested topics: `code-quality`, `technical-debt`, `quality-audit`, `static-analysis`, `developer-tools`, `open-source`.

Optional owner-run publication commands if GitHub CLI is configured and publication is authorized:

```bash
git init -b main
git add README.md LICENSE NOTICE CONTRIBUTING.md SECURITY.md .gitignore .editorconfig .github docs schemas examples tools
git commit -m "docs: initialize quality audit kit specification"
gh repo create maxd4/quality-audit-kit --public --source=. --remote=origin --push
```

Run these commands from the directory that **contains** `README.md` and after inspecting `git status`; never run them inside the CleanMyMap checkout. Do not run `gh repo create` if the repository already exists.
