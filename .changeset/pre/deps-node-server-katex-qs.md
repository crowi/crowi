---
"@crowi/api": patch
"@crowi/plugin-renderer-katex": patch
---

Updated dependencies that had reported vulnerabilities: `@hono/node-server` to 2.1.5 (static-file middleware bypass; Crowi does not use its `serveStatic`), `katex` to 0.18.11 (prototype pollution bypassing trust restrictions), and the transitive `qs` to 6.17.1 (DoS in `stringify` with `arrayFormat: 'comma'`, which Crowi does not call).
