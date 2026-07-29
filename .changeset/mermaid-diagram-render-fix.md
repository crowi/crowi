---
'@crowi/plugin-renderer-mermaid': patch
'@crowi/web': patch
---

Fix Mermaid diagrams rendering as invisible (0×0) on both the saved page view and the live editor preview.

Three independent root causes, all fixed:

- Mermaid's generated SVG declares `width="100%"` with no absolute height (only a `viewBox`), giving the base64-embedded `<img>` no resolvable intrinsic size once placed inside the diagram wrapper's `inline-block` element (whose own width is itself `auto`, sized from its content) — the two collapsed to 0×0. The renderer now derives `width`/`height` attributes from the sanitized SVG's own `viewBox` and adds them to the emitted `<img>` tag.
- The page view and editor preview's `img:` markdown component overrides were both dropping any `width`/`height` a renderer plugin declared instead of forwarding them to the rendered `<img>` element, silently discarding the fix above.
- Gantt charts specifically rendered with a corrupted, negative-width layout (not just invisible) — traced to Mermaid's Gantt renderer falling back to a 0px layout width because jsdom's `offsetWidth` (used by this plugin's isolated render-worker) always returns `0` rather than `undefined`, so Mermaid's own `undefined`-only fallback never activated. The render worker now sets Mermaid's `gantt.useWidth` config explicitly to sidestep that measurement entirely.

Existing pages with a Mermaid diagram saved before this fix keep serving their previously-rendered (invisible) markup until next edited and saved — this matches how this renderer's cache versioning has always behaved for schema changes.
