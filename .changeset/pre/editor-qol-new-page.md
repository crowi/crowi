---
"@crowi/web": minor
---

Editor quality-of-life for new pages. Creating a page now opens the editor
ready to write: the editor auto-focuses and the caret lands on the blank
line below a path-derived H1 title that is pre-filled for you. The title is
derived so a daily note keeps its context — `/user/foo/memo/2026/06/08`
seeds `# memo/2026/06/08`, while `/crowi/qa/rfc-0011-mcp-server` seeds
`# rfc-0011-mcp-server`.

Saving now leaves the editor and returns to the page view, which loads the
revision you just saved instead of a stale cached copy — a freshly created
page no longer briefly shows "page not found", and an existing page no
longer shows its pre-edit content, on return.
