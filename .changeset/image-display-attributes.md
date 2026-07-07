---
'@crowi/api': minor
'@crowi/web': minor
---

Markdown images now support a Pandoc-style attribute block right after the image: `![alt](url){width=60% align=center}`. Supported keys are `width` / `height` (a number followed by `%` or `px`, within sane bounds) and `align` (`left`/`center`/`right`) / `float` (`left`/`right`, wins over `align` when both are set). A standalone image (nothing else in its paragraph) renders as a `<figure>` so `align`/`float` apply; an image followed by more text stays inline and only `width`/`height` apply. Any out-of-range or unrecognised value is simply dropped instead of breaking the page, and a plain `![alt](url)` with no attribute block renders exactly as before.

The new server-side transform is bundled into the core renderer pipeline (`RENDERER_PIPELINE_VERSION` 0.7.0 → 0.8.0), and the web renderer re-validates every display attribute by value — not by trusting the `data-crowi-image-*` attribute names — so the same rules apply whether they came from the Markdown transform or were hand-written as raw HTML. The editor also gained a hover/focus tooltip on image spans for setting width/align/float without typing the `{...}` syntax by hand; it respects read-only mode (including the realtime-collab editor cap being reached mid-session). Uploading an attachment via paste/drag-and-drop/the insert button still emits a plain image with no attributes by default.
