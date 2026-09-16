---
"@crowi/api": minor
---

Add a blocking preflight migration, `page-liker-seenusers-to-relations`, that moves `pages.liker` / `pages.seenUsers` into the independent `likes` / `seens` collections and then removes both fields from `pages`. This affects every deployment up to and including alpha.17, not only v1 — those legacy arrays are still how earlier alpha releases stored Like and seen-by membership. Until this migration is applied, the api refuses to boot under the default `block` preflight policy, because the `likes` / `seens` unique index does not exist yet and Like / seen-by counts read as zero. Applying it requires a maintenance window: stop all writers, take a MongoDB backup, then run `crowi-admin migrate apply --id page-liker-seenusers-to-relations` before starting the new binary. See the "Migrating Like / seen-by relations" section of the v1 upgrade guide for the full runbook and failure-recovery steps.
