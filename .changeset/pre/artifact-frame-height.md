---
"@crowi/web": minor
"@crowi/api": minor
"@crowi/api-contract": patch
---

An HTML artifact page now grows to fit its content, so the page scrolls as one document instead of showing a second scrollbar inside the artifact's frame, and the page title carries an "Artifact" pill above it, like the one a portal carries in its header.

To make the height measurable, the artifact delivery route (`GET /api/artifact/{pageId}/{revisionId}`) now appends one fixed script after the stored document that reports the document's height to the page, and its `Content-Security-Policy` always authorises that script by hash — so `script-src` is no longer `'none'` for an artifact without scripts of its own. The stored HTML is unchanged, and the download route still returns exactly what was stored. A document that sizes itself from the viewport (for example `min-height: 100vh` plus padding) stops growing the frame after one step and scrolls the remainder inside it; until the first report arrives, the frame keeps its previous fixed height.
