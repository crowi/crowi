---
'@crowi/web': patch
---

Fix Markdown tables collapsing into a one-character-per-line column on narrow (mobile) screens when a cell holds a long unbroken token such as a file path or identifier — the table now keeps its column structure and scrolls horizontally within its existing wrapper instead, matching GitHub / Claude Code table behaviour. The fix is scoped to table cells only (`th`/`td`); ordinary paragraph and list text keeps wrapping long tokens exactly as before, and it applies equally to GFM `|...|` tables and raw HTML `<table>` written directly in the page body.
