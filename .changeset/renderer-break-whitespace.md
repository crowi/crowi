---
"@crowi/api": patch
---

Treat every spelling of an attribute-less `<br>` as a line break for non-web clients, not just the three that happened to be listed. A `<br >` or `<br  />` — same tag, same meaning, indistinguishable to anyone reading the page — used to stay a placeholder on clients that read the versioned AST, while `<br>` next to it became a real break. The accepted set is now defined by what the Markdown parser can actually produce: zero or more space, tab, CR or LF before an optional `/`. Attributes, other tags, and text sharing the node still disqualify it, exactly as before.
