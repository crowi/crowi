---
"@crowi/api": patch
"@crowi/api-contract": patch
---

Saving admin settings that fail to persist to the database now returns an error instead of a false 200, and the failed value is no longer applied to the running instance or its replicas — a reload used to silently show the pre-save value with no indication anything had gone wrong.
This also fixes plugin config saves: a connectivity-check notice ("saved, but verification failed") could previously appear for a value that was never actually written to the database.
`PUT /admin/app` and `PUT /admin/mail` can now return a 500 on a write failure, matching the existing behavior of `/admin/auth`, `/admin/security`, and `/admin/plugins/config`.
