---
'@crowi/web': patch
---

Fix portal edits not appearing after save. Saving a portal and returning to it
kept showing the pre-edit body: the post-save cache invalidation refreshed the
single-page detail query (`['page']`) but not the list/portal family
(`['pages']`) that the portal view is rendered from. Both save paths (the
realtime `crowi:save` flow and the HTTP `useUpdatePage` fallback) now share one
`invalidatePageContentQueries` helper that refreshes the page detail, the
list/portal + sidebar family, page history, and drafts together, so the
invalidation set can no longer drift between them.
