---
'@crowi/web': patch
---

Render unrecognised inline HTML tags in a page body as the literal text the
author typed, instead of silently dropping them. Writing something like `shows
"No <thing> yet" tooltip` previously rendered as `No  yet` — the markdown
pipeline parsed `<thing>` into an empty unknown DOM element, which both vanished
from the output and made React log "The tag <thing> is unrecognized in this
browser…". Unknown raw-HTML tags are now escaped before rendering so they show
verbatim; recognised HTML/SVG tags, custom elements, and shiki code-highlight
markup are unaffected. Applies to both the page view and the editor preview.
