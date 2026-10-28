---
'@crowi/cli': minor
---

Added `crowi diff <path-or-id> --file <file>`, which compares a page's latest body with a local file (ignoring the number of trailing newlines) and exits 1 with a unified diff when they differ; `crowi get` no longer adds an extra blank line after a body that already ends with a newline.
