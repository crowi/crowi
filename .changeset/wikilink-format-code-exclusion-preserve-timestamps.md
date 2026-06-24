---
'@crowi/api': patch
---

Fix the `wikilink-format` migration so it no longer rewrites `</…>` tokens written inside code examples (fenced code blocks and inline code spans), which previously corrupted code like ```` ```tsx </AppShell> ``` ```` into `[[/AppShell]]` and could falsely report the migration as pending. Body-rewrite migrations (`wikilink-format`, `files-url-to-attachments`, `wikilink-html-recover`) now also preserve each page's `updatedAt` and `lastUpdateUser` during `apply` instead of bumping them to "now" / the migration bot, so applying a migration no longer reorders recently-updated lists or overwrites a page's "last updated by".
