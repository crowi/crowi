---
"@crowi/web": minor
---

Viewing an HTML artifact page (RFC-0020) now runs its content instead of the endless "Rendering…" it showed before. Opening the page shows a brief "Preparing artifact..." spinner while it automatically mints a short-lived signed URL, then loads the content inside a sandboxed frame that cannot navigate to other sites, submit forms, or open popups, with a permanent notice next to the frame that it is sandboxed, agent-generated content and that anything typed into it may not stay private. Switching to a different revision from the page's history tears the frame down and runs the new revision automatically in turn. If preparing the frame fails, a notice explains why and offers to try again. On a server where artifact delivery isn't configured, the page explains that instead of running anything.
