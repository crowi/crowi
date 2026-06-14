---
'@crowi/cli': minor
---

Add `@crowi/cli`, the end-user command-line interface for Crowi (RFC-0012). The
`crowi` binary talks to a Crowi server over HTTP and is distinct from
`@crowi/admin-cli`, which connects directly to MongoDB for operators.

Authentication uses the first-party public OAuth client (RFC-0010) with PKCE —
no client secret. Three login flows are supported: browser authorization-code
over an ephemeral loopback redirect (default), the device-authorization grant
for headless / SSH sessions (`--device`), and storing a pre-issued personal
access token directly. Tokens are persisted as plain JSON at
`~/.config/crowi/contexts.json` (honouring `$XDG_CONFIG_HOME`) with file mode
`0600`, and a 401 transparently triggers a single coalesced refresh + retry.
Multiple servers / accounts are managed as named profiles.

Commands cover reading (`search`, `get`/`cat`, `ls`), writing (`create`,
`edit`, `update`, `mv`, `rm` — with optimistic-lock conflict handling that
aborts by default and only overwrites with `--force`), and, behind their own
OAuth scopes, `comment`, `attach`, `bookmark`, `watch`, and `open`. Outgoing
arguments are validated against the shared request contracts before any call
leaves the machine, while responses are parsed leniently so the CLI tolerates
version drift across self-hosted instances; it reads the `GET /api/v2/app/info`
version / capability signal to warn (never refuse) on skew and to pre-empt
disabled features. `--json` and `--template` output make commands scriptable,
`crowi completion <bash|zsh|fish>` emits shell completions, and
`pnpm --filter @crowi/cli build:binary` produces a standalone single-file
executable.
