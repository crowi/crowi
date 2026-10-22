---
"@crowi/api": minor
---

A Markdown link whose destination is a raw, unescaped absolute path containing a space — e.g. `[label](/absolute path with spaces)`, which CommonMark's standard link-destination grammar rejects and previously left as literal text — is now leniently recovered into a clickable internal link to the actual page, and its Backlinks entry is created the same way. This is an intentional, narrow deviation from CommonMark: image syntax (`![alt](/a b)`), an escaped form (`\[label\](/a b)`), a raw-space token inside a code fence or inline code, and a raw-space fragment already nested inside another link's label are all left untouched as literal text. Recommended notations for linking to a space-containing page path (`%20`, `+`, or `<...>`) are unaffected and remain the more CommonMark-portable choice.
