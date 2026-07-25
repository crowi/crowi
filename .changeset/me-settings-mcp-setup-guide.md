---
"@crowi/web": minor
---

Add an MCP setup guide to the user settings page, and rename the tab that holds it from "Security" to "Password / API tokens / MCP" so its contents are discoverable from the tab strip.

The new "MCP setup" card sits between the password form and the personal access tokens list, mirroring the order a user actually follows: issue a read-only PAT, then register the server. It shows the instance's own `/api/v2/mcp` endpoint (resolved from `NEXT_PUBLIC_API_URL` or the browser origin, so it is correct for both same-origin and split-host deployments) and copy-pasteable registration snippets for both Claude Code (`claude mcp add --transport http …`) and the Codex CLI (`codex mcp add … --bearer-token-env-var`, plus the equivalent `~/.codex/config.toml` block), each with its own verification step and a link to the MCP operations documentation.
