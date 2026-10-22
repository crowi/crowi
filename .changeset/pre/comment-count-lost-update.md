---
'@crowi/api': patch
---

Fix a page's comment count showing a stale value after comments are posted or deleted at nearly the same time. The count was recomputed by reading the current number of comments and then writing it, with no ordering between two recomputations for the same page — so a slower one could overwrite a newer, correct value with the number it had read earlier. The wrong count then stuck until the next comment was added or removed on that page. Recomputations for the same page are now serialized, so the last one always writes the true count. (Recomputations still run per API process, so a deployment running several API replicas can in principle still interleave; the count self-corrects on the next comment change.)
