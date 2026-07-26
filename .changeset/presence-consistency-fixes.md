---
"@crowi/api": patch
"@crowi/api-contract": patch
"@crowi/web": patch
---

Fix four presence (live "who's viewing this page") consistency bugs.

Viewer membership is now refcounted per WebSocket connection instead of per user, so closing one tab of a multi-tab/multi-replica session no longer makes the user vanish from the viewer list while a sibling tab is still open — only the last connection leaving actually removes them. Viewer-list broadcasts now carry a monotonically increasing per-page generation number (a backward-compatible additive field on the `viewers` WebSocket message) so an old, out-of-order snapshot can never overwrite a newer one on the client. Navigating between pages no longer flashes the previous page's viewer list (including their identities) on the next page's first render. Finally, when the server fails to register a viewer (e.g. a transient Redis error) it now closes the WebSocket so the client's existing reconnect logic recovers, instead of leaving the connection open with a permanently stale viewer list.
