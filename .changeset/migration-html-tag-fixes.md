---
'@crowi/api': minor
---

Fix the HTML-tag handling in headings / TOC and recover the close-tag corruption
the earlier `wikilink-format` migration could introduce.

- **`wikilink-format` close-tag clobber fix**: the deprecated presentational
  tags `font` / `center` / `marquee` / `blink` / `applet` are now treated as
  known HTML elements, so `</font>` etc. are no longer mistaken for v1
  angle-bracket wikilinks and rewritten to `[[/font]]`. No new corruption can
  occur.
- **`wikilink-html-recover` preflight migration**: reverts bodies already
  mangled into `[[/<x>]]` back to `</x>`, scoped to exactly those five
  deprecated tags (the only names the misfire could have produced). Genuine
  single-segment wikilinks — including ones named after standard HTML elements
  such as `[[/section]]` / `[[/div]]` — are preserved. A `[[/font]]` is left
  untouched when a live (published, non-redirect) page literally named `/font`
  exists, and reported for manual review instead.
- **TOC inline-HTML strip**: heading TOC labels now strip only *known* HTML tags
  (e.g. `<font …>…</font>` → the inner text), so a literal `<` in heading text
  (`## price < 100`) or an unknown tag-like token (`## Using List<int> in C#`)
  is preserved verbatim instead of being dropped.
- **`toc-html-strip` preflight migration**: cleans up `meta.toc` labels that
  already captured inline HTML, stripping the markup out of the label text in
  place while preserving the stored `anchorId` so existing in-page anchor links
  keep resolving.
