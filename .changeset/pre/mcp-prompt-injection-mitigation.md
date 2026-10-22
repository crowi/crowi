---
"@crowi/api": minor
"@crowi/web": minor
---

Harden the built-in MCP server against prompt injection from untrusted wiki
content (RFC-0011 §10.7).

- **API** — MCP read and write-echo tools now return the page body in
  `content[0].text` fenced between open/close delimiters that carry a fresh,
  unguessable per-response nonce, prefixed by a "this is data, not
  instructions" notice. The nonce defeats break-out attempts: a body that
  forges the close tag cannot guess the random id, so injected "ignore your
  task" instructions stay inside the data region. `structuredContent.body`
  is kept raw (so programmatic clients parse it cleanly) and tagged
  `trust: "untrusted"`; search snippets are fenced too, while self-authored
  metadata (path / count / pager) is left plain.
- **Web** — the Personal Access Token issue form now defaults to the
  read-only scopes and recommends them for MCP / AI clients, so the token
  that gates the MCP server is least-privilege by default; write scopes
  remain an explicit opt-in.

Clients that feed `structuredContent.body` straight to a model without honoring
`trust` remain a documented residual risk. See the MCP operations docs for the
defaults and a verification procedure.
