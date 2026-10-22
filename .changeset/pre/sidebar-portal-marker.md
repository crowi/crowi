---
"@crowi/api": patch
"@crowi/web": patch
---

Refine how portals appear in the sidebar tree. Directory rows now keep the
folder icon and show a small portal marker after the name (e.g. `crowi/ ◎`)
instead of swapping the leading folder icon for a compass. Draft (unpublished)
portals no longer count as portals in the sidebar — a draft-only path is not
shown at all, and a folder that merely has a draft portal shows as a plain
folder without the marker.
