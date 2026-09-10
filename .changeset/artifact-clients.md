---
'@crowi/api': minor
'@crowi/cli': minor
---

MCP tools and the `crowi` CLI can now write and read HTML artifact pages (RFC-0020). `crowi_create_page` / `crowi_update_page` accept an optional `content_type: 'markdown' | 'artifact'` field, and their results — along with `crowi_get_page` / `crowi_get_revision` — report a page or revision's `content_type`. `crowi create` / `crowi update` gained a matching `--type <markdown|artifact>` flag (never inferred from a file extension or body content), `crowi get --json` reports `contentType`, and `crowi edit` opens an `.html` temp file for an artifact page while preserving its kind on save. A rejected artifact write is now shown with the server's rule identifier, reason, and (when applicable) offending target — via the CLI's exit code 6 and an enriched message, and via MCP's `isError` result text and `structuredContent`. All of this is additive: an existing MCP or CLI caller that never passes `content_type` / `--type` keeps behaving exactly as before.
