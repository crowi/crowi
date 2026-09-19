---
"@crowi/web": minor
"@crowi/api": patch
---

An HTML artifact page can now be maximized to fill the browser window, for artifacts wider than the page column, and from there switched to full screen where the browser supports full screen for page elements (not on iPhone). The artifact keeps its state across both: its frame is restyled in place, never reloaded. Escape or the Restore button returns to the normal page; Escape works even while focus is inside the artifact, forwarded by the script artifact delivery appends, unless the artifact handles Escape itself. The sandboxed-content notice stays visible while maximized.
