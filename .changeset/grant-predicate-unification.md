---
"@crowi/api": patch
---

Fix a page-visibility bug where a non-creator (e.g. an admin) changing a private page's grant could silently drop the page from the creator's own listings/search/portal results, even though the creator could still open it directly by id. `visiblePageGrantOr` (the query-time `$or` filter used by all listing/search/portal queries) now includes a creator clause, deriving from the same rule as the in-memory `isGrantedFor` check. `Page.updateGrant` also keeps the creator in `grantedUsers` alongside whoever changed the grant, and `isGrantedFor`'s membership check now uses ObjectId value comparison (`.equals()`) instead of reference comparison, fixing a case where populated `grantedUsers` entries could be missed.
