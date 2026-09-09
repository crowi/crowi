---
'@crowi/api': patch
---

Fix a subtree move being reported as failed when it had fully succeeded. Renaming a subtree commits each member in three writes — the page move and the staged history event land together first, the event row is written a few round-trips later, and the operation's result is cached later still. Crowi only looked for the event row, so a delivery that arrived in that gap — a client retry after a timeout, a double submit, or a single request whose history write failed after the pages had already moved — found no proof the move had happened and answered `Failed to move the whole subtree — some pages may already have been moved`, even though every page had moved and every history entry was intact. Completion is now read from the staged entry as well as the row, from a single primary-pinned snapshot, so the gap reports success like any other moment.
