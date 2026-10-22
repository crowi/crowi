---
"@crowi/api": patch
---

Resetting a password through the emailed link now also revokes the account's OAuth sign-ins (such as the CLI and MCP connections) and its personal access tokens, not only its web sessions. An OAuth access token that was already issued keeps working until it expires (one hour by default).
