---
"@crowi/api": patch
---

Upgrade Mongoose 8 → 9 (mongodb driver 6 → 7, mongodb-memory-server 10 → 11) to keep the ORM on its current major — a debt-reduction follow-up to the earlier 6 → 8 bump. Behavior and the API/JSON contracts are unchanged; the fallout was a `pre('validate')` codemod (the `next()` callback argument is gone in v9), the `FilterQuery` → `QueryFilter` type rename, removal of the long-dead `mongoose.Promise = global.Promise` line, and a handful of stricter v9 query/create type casts.

Also pin the optional-peer `socks` to `^2.8.7` via `pnpm.overrides` to clear the `socks@2.8.4 → ip-address@9.0.5` GHSA advisory chain. That fix is the `socks` override itself — orthogonal to the Mongoose major and equally applicable on Mongoose 8 (socks has always been an optional peer of `mongodb`, never a hard dependency) — folded into this bump so the chain's removal is guaranteed rather than left incidental to re-resolution.
