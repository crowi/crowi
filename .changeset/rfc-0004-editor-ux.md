---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Editor UX enhancement (RFC-0004) v2.2 is now available. Four features were added on top of the minimal CodeMirror 6 editor introduced in RFC-0003, lifting the editor from "usable" to "productive".

Main features:

- **Autocomplete**: `@` + characters suggests users, `[[` + characters suggests pages, in a dropdown under the cursor. Three-way separation of display / insert / view (insertion uses the canonical `@username` / `[[/full/path]]` forms), 100ms debounce, LRU cache + a footer Refresh, suppressed inside code blocks / math / link syntax and at mobile widths.
- **Paste handler**: smart-converts a single pasted URL to `[text](url)` / autolink, uploads image blobs to `POST /api/v2/attachments/upload` with auto-naming `pasted-<ts>.<ext>`, and updates an `![Uploading…(%)…]()` placeholder in-place via a Yjs transaction.
- **Drag & drop upload**: dropping files uploads with progress at the cursor position and inserts a reference (images `![](url)` / others `[](url)`), processes multiple files serially, and is disabled in read-only mode.
- **Draft pages**: a new page starts as `Page.status: 'draft'` and transitions one-way to `'published'` on save. `POST/GET/DELETE /api/v2/pages/drafts`, same-path conflicts return 409 + owner info, with a `/me/creating-pages` management view. Drafts are author-only and excluded from listing / search / collab.
- **Toast notification utility**: a minimal `notify.info/warn/error` shared by the above.

The `@crowi/api-contract` minor bump is for the new autocomplete / drafts / attachment-upload contracts and the added `status` field on the `Page` schema. Uploads enforce a 20/min/user rate limit, size caps (paste 10MB / D&D 50MB), and a file-type allow-list.

See `apps/crowi-site/content/docs/ja/guide/` (`attachments.mdx` / `pages.mdx` / `markdown.mdx`) for the user-facing guide, `apps/crowi-site/content/docs/ja/operations/storage.mdx` for operator upload limits, and `docs/rfcs/0004-editor-ux-enhancement.md` for the design rationale.
