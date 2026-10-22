---
'@crowi/api': patch
---

Add an immutable `Revision.page` (`Page` ObjectId ref) alongside the existing `path` string, and switch revision/comment/attachment-usage/page-body history lookups (`GET /pages/revisions/:id`, `GET /pages/revisions?ids=...`, `GET /comments?revision_id=...`, `GET /pages/:pageId/attachments/usage`, `GET /pages?path=...&revision_id=...`, `POST /pages/revert-to-revision`) to resolve/verify the owning page by that immutable id instead of reverse-looking-up or comparing `path`. Fixes a latent grant leak where deleting a page and later reusing its `path` for an unrelated page could let that new page's grant expose the old page's private revision body / comments / attachment metadata, or let a caller with edit access to the new page revert it to the old page's private body. A boot migration backfills `page` onto existing revisions.
