---
'@crowi/web': patch
---

Use the compass icon consistently to mark portal pages. Portal pages (paths ending in `/`) were flagged with three different icons depending on where they appeared — a folder in the page list and a document in the search results / recent-pages dropdown — while the portal header and "What is a portal?" dialog already used a compass. They now all use the compass, so a portal reads the same everywhere and matches the "Portal" sidebar label. The folder icon is kept only on the fallback header shown for folders that have no portal yet, so "has a portal" stays visually distinct from "no portal".
