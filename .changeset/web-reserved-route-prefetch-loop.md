---
"@crowi/web": patch
---

Pages no longer keep re-requesting the history, search and notifications views in the background while they stay open. A link into one of those views, such as the "updated N ago" link in a page or portal header, made the browser fetch it hundreds of times a second until the tab was closed.
