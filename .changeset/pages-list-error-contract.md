---
"@crowi/api-contract": patch
"@crowi/api": patch
"@crowi/web": patch
---

GET /pages/list now returns a 500 internal error for every request shape when listing fails, instead of an empty list for requests without `path_prefix`. The rename dialog shows an error with a retry button, and blocks the move, when its subpage list cannot be loaded.
