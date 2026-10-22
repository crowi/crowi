---
"@crowi/api": minor
---

Add a built-in MCP (Model Context Protocol) server (RFC-0011). A new
Streamable-HTTP `/mcp` endpoint, hosted inside the `@crowi/api` process,
exposes the wiki to MCP-capable AI clients (Claude Desktop / Claude Code /
others) as tools. It is protected by Crowi's existing Personal Access Token
or OAuth access token auth and per-tool scope enforcement, with no new auth
code: each tool dispatches in-process to the same API routes the web app
uses, so page grants, scopes, and revision conflicts behave identically to
the rest of the API.

v1 ships 13 page tools — 8 read (`crowi_search_pages`, `crowi_get_page`,
`crowi_list_pages`, `crowi_list_child_pages`, `crowi_get_page_history`,
`crowi_get_revision`, `crowi_get_backlinks`, `crowi_autocomplete_pages`)
and 5 write (`crowi_create_page`, `crowi_update_page`, `crowi_rename_page`,
`crowi_delete_page`, `crowi_revert_page`). The endpoint is stateless
(per-request session) and per-user rate-limited; Bearer-token auth is its
gate (DNS-rebinding `Host` pinning is intentionally off — redundant for an
authenticated, non-browser endpoint). A read-only token (`pages:read`)
yields a read-only MCP; `admin:*` scopes are never issuable, so admin
operations are unreachable. See the operations docs for setup and a
prompt-injection note.
