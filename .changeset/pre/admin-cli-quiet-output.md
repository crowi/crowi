---
"@crowi/admin-cli": patch
---

Clean up `crowi-admin`'s output (affects `migrate` / `rebuild` / `replace` / `watcher-backfill`, and the `pnpm migrate` wrapper). The `[crowi] Loaded N plugin(s)` boot line no longer prints to stdout: in development it moves to stderr (so `crowi-admin migrate plan --json | jq` keeps working), and in production (`NODE_ENV=production`) it is suppressed entirely. Node's own `DeprecationWarning`s (e.g. `DEP0169` from a transitive dependency's `url.parse()` call) are now suppressed on every `crowi-admin` invocation, dev and prod alike. Server boot output (`pnpm dev` / the production server) is unaffected.
