---
'@crowi/api-contract': minor
---

Fix the HTML-tag handling in headings / TOC and recover the close-tag corruption the earlier `wikilink-format` migration could introduce.

- **`wikilink-format` close-tag clobber fix**: the deprecated presentational tags `font` / `center` / `marquee` / `blink` / `applet` are now treated as known HTML elements, so `</font>` etc. are no longer mistaken for v1 angle-bracket wikilinks and rewritten to `[[/font]]`. No new corruption can occur.
- **`wikilink-html-recover` preflight migration**: reverts bodies already mangled into `[[/<x>]]` back to `</x>`, scoped to exactly those five deprecated tags (the only names the misfire could have produced). Genuine single-segment wikilinks — including ones named after standard HTML elements such as `[[/section]]` / `[[/div]]` — are preserved. A `[[/font]]` is left untouched when a live (published, non-redirect) page literally named `/font` exists, and reported for manual review instead.
- **Clean TOC anchors + labels, with no data rewrite**: heading anchor ids are slugged from the HTML-stripped heading text, so in-page anchors are clean and `id == href`; the TOC label strips inline HTML at display time using the same shared helper. Stored `meta.toc[].text` and page bodies are left raw (as authored) — nothing is migrated — and re-saving a page upgrades its anchor hash to the clean slug. A literal `<` in heading text (`## price < 100`) or an unknown tag-like token (`## Using List<int> in C#`) is preserved verbatim.
