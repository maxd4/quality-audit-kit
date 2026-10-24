# Security policy

**No published binary, npm CLI or hosted service currently exists.** The present surface consists of documentation, data schemas, fictional examples and a local fixture checker.

If you find a vulnerability in a future implementation, prefer a **private GitHub vulnerability report** when repository security advisories are enabled. Otherwise contact the maintainers privately using a verified project channel before disclosing exploit details; do not put tokens, personal information or exploitable details in a public issue.

Future implementations must avoid executing untrusted shell command fragments, treat analyzer output as untrusted input, restrict archive extraction paths, redact secrets, respect repository boundaries and avoid publishing raw source/code or logs by default.
