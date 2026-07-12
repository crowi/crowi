---
"@crowi/web": minor
---

Add a fullscreen expand affordance for Markdown tables on the page view.

Every table (GFM or raw HTML) now gets a small, always-present "Expand table" button in a toolbar row above it — low-opacity by default, full-opacity on hover/focus, and always full-opacity on touch (coarse-pointer) devices, since discoverability without hovering was the whole point on mobile. Clicking it opens the same table at near-fullscreen size in a Radix `Dialog`, with both horizontal and vertical scrolling, so wide or tall tables are far easier to read on small viewports. The table itself is mounted in exactly one place at a time (inline or in the dialog), so `id` attributes and `url(#id)` SVG references inside a table never collide or break. This is a page-view-only change — the editor preview's table rendering is untouched.
