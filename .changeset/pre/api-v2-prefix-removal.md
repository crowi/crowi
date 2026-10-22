---
"@crowi/api": major
"@crowi/api-contract": major
"@crowi/web": major
"@crowi/cli": major
---

BREAKING: the public API namespace moves from `/api/v2` to `/api`. `v2` never
carried real version-negotiation meaning (contracts are root-relative, the
segment was stripped verbatim at the listener boundary), and Crowi 2.0 has no
production deployments and no parallel API generations left to protect — see
`docs/rfcs/0006-hono-integration.md` for the framework migration that made the
old `/api/v2/*` HTTP shape a fixed point in the first place. There is no
server-side alias or redirect for `/api/v2/*`: after upgrading, every request
to the old prefix returns a plain 404.

**MCP clients** (Claude Desktop, Codex CLI, or any other client with a Crowi
MCP server URL configured directly — including anyone who followed the
"MCP setup" card on the user settings page before this release) must update
the endpoint from `<host>/api/v2/mcp` to `<host>/api/mcp`. Existing PAT /
OAuth credentials are unaffected — only the connection URL changes.

**`@crowi/cli` users** must upgrade to this release (or later) in the same
deploy as the api. An un-upgraded CLI will 404 against the new listener; on
`crowi logout`, the CLI now also warns (rather than silently succeeding) when
the cached OAuth revoke endpoint returns a non-2xx status, since local
credentials are removed regardless — re-run `crowi login` or ask an
administrator to revoke the stale token server-side.

**Operators running multiple api replicas** must treat this as a coordinated
fleet cutover, not a normal one-at-a-time rolling restart: the old and new
listeners cannot interpret each other's prefix, so any deploy topology that
lets old and new api replicas serve traffic at the same time causes 404s for
whichever client hits the "wrong" generation. Stop all api replicas and start
them back up together on the new version (or cut a blue/green fleet over as a
single step), and use the preflight check (`GET /api/openapi.json` returns
200, `GET /api/v2/openapi.json` returns 404 on every replica before accepting
traffic) documented in the new "api prefix cutover" section of
`operations/self-hosting`. Single-instance deployments (including local dev)
are unaffected by this requirement — there is only one replica, so old/new
never coexist.

Everything else about the HTTP surface is unchanged: route paths, request/
response shapes, auth, and scopes are identical under the new prefix. Browser
users see no visible change (the web app talks in same-origin relative paths
and picks up the new base URL on next build), except that a tab left open
since before the cutover will 404 on API calls until reloaded. Attachment /
avatar URLs already embedded in page bodies keep resolving via permanent
canonicalization on both the server (attachment lookup) and the web client
(display-time URL rewrite) — no database migration is required or performed.
