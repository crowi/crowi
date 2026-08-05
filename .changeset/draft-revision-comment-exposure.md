---
'@crowi/api': patch
---

Stop a draft page's contents from being readable by other users. A draft is stored with a public grant and is meant to be kept private by a separate "only the author sees it" rule, but the revision endpoints and the comment endpoints checked only the grant — so another signed-in user who had a revision or page id could read an unpublished body, list its comments, and delete them. All three now apply the author rule and answer "not found", so a draft's existence is not disclosed either.
