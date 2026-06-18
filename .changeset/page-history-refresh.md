---
"@crowi/web": patch
---

Fix the page-history list not refreshing after an edit or a revert. Revision
creating mutations (page update, revert-to-revision) now invalidate the
`['revisions']` query, so a newly-pushed revision shows up in `/_history`
immediately instead of being hidden behind the 60s default React Query
`staleTime` until a full browser reload.
