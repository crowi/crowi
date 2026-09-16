---
"@crowi/web": minor
---

Viewing an HTML artifact page (RFC-0020) now shows a placeholder explaining that its content is agent-written HTML instead of the endless "Rendering…" it showed before. Opening the page automatically mints a short-lived signed URL and loads the content inside a sandboxed frame that cannot navigate to other sites, submit forms, or open popups, with a permanent notice next to the frame that it is sandboxed, agent-generated content and that anything typed into it may not stay private. A "Stop" button tears the frame down, and a "Run" button resumes it on demand afterward; switching to a different revision from the page's history always resets back to the idle state and runs the new revision automatically in turn. On a server where artifact delivery isn't configured, the placeholder explains that instead of running anything.
