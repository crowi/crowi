---
'@crowi/web': patch
---

Copy buttons (page markdown, code blocks, heading anchors, the restricted-share URL, and the MCP setup section) now report a failed copy instead of doing nothing. On a non-secure origin, where `navigator.clipboard` doesn't exist, the button explains that a secure connection (HTTPS) is required; any other clipboard failure shows a generic "couldn't copy" message without guessing at a cause. The page-markdown button's "Copied" state also no longer survives a page navigation — it now resets whenever the underlying page changes.
