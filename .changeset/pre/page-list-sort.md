---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Add sorting to the directory / portal page listing. The list page now offers a sort control with three options — last updated, date created, and name — surfaced as a dropdown in the listing's section header.

`GET /pages/list` gains optional `sort` (`updatedAt` | `createdAt` | `path`) and `order` (`asc` | `desc`) query parameters, defaulting to `updatedAt` descending so existing callers are unaffected. Sorting applies to the path and root listings; the per-user "created pages" listing keeps its own newest-authored-first order.
