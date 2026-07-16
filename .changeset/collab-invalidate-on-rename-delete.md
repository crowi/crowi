---
'@crowi/api': patch
'@crowi/collab': patch
'@crowi/api-contract': patch
---

Fix a correctness hole where a live collaborative editor open before a page was renamed, soft-deleted, or reverted could still save its content afterwards, silently clobbering the renamed/deleted state instead of being rejected.
The fix introduces a monotonic collab lifecycle epoch (`Page.collabLifecycleVersion`) that advances atomically with every rename/delete/revert/body-replace and is enforced at four boundaries — wsToken mint, WebSocket authentication, document load, and the atomic save compare-and-set — so a stale editor session is refused rather than allowed to overwrite the page, including across multiple api replicas.
Rename/delete now also opens the existing reload-prompt dialog on any live editor for that page, and soft/hard delete purge the page's collaborative editing state (Yjs snapshot and pending updates) as defense-in-depth.
