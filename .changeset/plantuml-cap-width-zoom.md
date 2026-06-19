---
'@crowi/web': minor
---

PlantUML diagrams now stay within the article width instead of overflowing the
column (and dragging the page wider than the viewport). Hovering a diagram
reveals a `+` affordance, and clicking it opens a near-full-screen lightbox that
shows the diagram at natural size with scroll/pan, so wide sequence diagrams
stay readable. Applies on both the page view and the editor preview, for the SVG
embed and the PNG fallback.
