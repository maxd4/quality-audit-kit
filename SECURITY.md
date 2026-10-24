# Security policy

**No published npm package, hosted service or dashboard currently exists.** The repository contains a private local CLI tarball workflow, documentation, data schemas, fictional examples and local checks. `npm run test:package` installs only a local tarball with network access disabled and removes it afterward; no publication is performed.

If you find a vulnerability in a future implementation, prefer a **private GitHub vulnerability report** when repository security advisories are enabled. Otherwise contact the maintainers privately using a verified project channel before disclosing exploit details; do not put tokens, personal information or exploitable details in a public issue.

Future implementations must avoid executing untrusted shell command fragments, treat analyzer output as untrusted input, restrict archive extraction paths, redact secrets, respect repository boundaries and avoid publishing raw source/code or logs by default.
