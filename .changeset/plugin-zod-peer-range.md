---
"@crowi/plugin-api": patch
"@crowi/plugin-aws": patch
"@crowi/plugin-mail-aws-ses": patch
"@crowi/plugin-mail-resend": patch
"@crowi/plugin-mail-smtp": patch
"@crowi/plugin-renderer-plantuml": patch
"@crowi/plugin-search-elasticsearch": patch
"@crowi/plugin-search-mongo": patch
"@crowi/plugin-search-opensearch": patch
"@crowi/plugin-storage-aws-s3": patch
"@crowi/plugin-storage-local": patch
---

Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
