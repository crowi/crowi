---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Administrators can now switch HTML sanitization for Markdown from the Security admin page (on by default): turning it off allows decorative style/class, passive layout elements and external HTTPS iframes in page bodies and the edit preview from the next time a page is opened, without modifying stored bodies. Even when off, author CSS background images (URL and other resource references) and CSS variables stay unavailable, and a style whose parsing does not match or that repeats a declaration is dropped as a whole attribute. External HTTPS iframes receive a fixed permission grant and only an initial Web, API or artifact origin is excluded, while ordinary Web pages can no longer be framed under either setting (the artifact relay document is the only exception). The Security settings API now also accepts partial updates, saving only the fields that are sent.
