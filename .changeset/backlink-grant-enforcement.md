---
"@crowi/api": patch
"@crowi/api-contract": patch
"@crowi/web": patch
---

Enforce page permissions on `GET /backlinks`.

The endpoint now grant-checks the target `page_id` before listing its backlinks, returning 404 (hiding existence) to callers who cannot read the page — previously any authenticated user could probe the existence and link graph of a private page by id. Each `fromPage` in the response is now also grant-checked individually and dropped if the caller cannot read it, the same way hidden-draft `fromPage`s already were. The route gains a `404` response in its contract.
