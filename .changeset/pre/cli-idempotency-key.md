---
"@crowi/cli": patch
---

Fix `crowi mv` and `crowi rm` (without `--completely`), which always failed with a missing-Idempotency-Key error since the server started requiring that header on rename and soft-delete requests. Both commands now generate a key automatically and attach it to the request, and `rm --force` reuses the same key across its revision-conflict retry. `rm --completely` was never affected by this bug (the hard-delete path never reads the header); it now also sends a key for consistency, though the hard-delete path still does not act on it.
