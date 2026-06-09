---
"@crowi/api": patch
---

Stop listing a portal's own document among its child rows. When viewing a
portal (e.g. `/crowi/`), the portal page is already rendered as the portal
card / header, so it no longer also appears as a row in the page list below
— where it was a redundant, no-op self-link. Applies to draft portals too.
