---
'@crowi/web': minor
---

Redesign portal pages (the document at a trailing-`/` path) as a folder entrance rather than a content page. Portals previously reused the full page header on top of the document's own markdown, which left two competing titles (the path-basename H1 and the document's `# heading`) and a wall of social metadata (the 0-count like / view / comment / backlink chips, plus the watch / bookmark / link-share toolbar) that read as noise on what is really a directory index.

The portal now leads with a compact context strip: a breadcrumb overline ending in the current folder name, a "Portal" tag shown only when a portal document actually exists, and a single muted provenance line (updater + relative update time). Actions are slimmed to bookmark (kept as a visible button), edit, and a kebab menu that folds like / watch / copy-link in. The path-basename H1 is dropped — the portal document's own leading markdown heading stands as the single page title, and only when the body has no leading H1 does the folder name fall back in as the title.
