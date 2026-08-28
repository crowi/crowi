---
"@crowi/api": patch
---

Fix a subtree rename occasionally being reported as a partial failure (HTTP 400) even though every page moved successfully. This happened when two deliveries of the same rename raced each other and the losing one checked whether the move had committed a moment too early, before the confirming record caught up — a timing race, not a logic error that could return the wrong page. No page data was ever affected; only the response reporting was wrong. Concurrent subtree renames now consistently report success when the move actually succeeded.
