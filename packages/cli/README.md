# @crowi/cli

End-user command-line interface for [Crowi 2.0](https://crowi.wiki). The
`crowi` binary talks to a Crowi server over HTTP using OAuth (RFC-0010 /
RFC-0012), so you can read, write, search, and edit your wiki from the
terminal.

> Status: in development. This package is the end-user CLI and is distinct
> from `@crowi/admin-cli` (`crowi-admin`), which is the operator-side tool
> that talks directly to MongoDB.

## Install

```bash
npm install -g @crowi/cli
```

## Authentication

`crowi` is a public OAuth client and uses PKCE — no client secret. Tokens are
stored as plain JSON at `~/.config/crowi/contexts.json` (honouring
`$XDG_CONFIG_HOME`), written with file mode `0600`.

There are three login flows:

```bash
# 1. browser authorization-code + PKCE over an ephemeral loopback redirect
#    (the default — opens your system browser)
crowi login https://wiki.example.com

# 2. device authorization grant for headless / SSH sessions (also chosen
#    automatically when no browser is detectable)
crowi login --device https://wiki.example.com

# 3. store a pre-issued personal access token directly (no OAuth round-trip)
crowi login --token <pat> https://wiki.example.com
```

The default scope is `pages:read pages:write`, which covers reading, writing,
renaming, deleting, and watching pages plus `whoami`. Pass `--scope
'<space list>'` to request more — the Phase 2 commands need their own scopes:

| Commands | Scope to add at login |
| --- | --- |
| `comment` (list/add/delete) | `comments:read comments:write` |
| `attach` (list/add/remove) | `attachments:read attachments:write` |
| `bookmark` (get/list/add/remove) | `bookmarks:read bookmarks:write` |
| `watch` (get/set) | none — rides the default `pages:*` |

`--scope` is validated against the server's issuable catalog before any request
leaves your machine, so a typo or a reserved `admin:*` scope fails fast.

## Global flags

| Flag | Description |
| --- | --- |
| `-p, --profile <alias>` | use a stored profile by alias |
| `--url <baseUrl>` | target a server ad-hoc (overrides the profile endpoint) |
| `--token <accessToken>` | use a bearer token directly (e.g. a PAT) |
| `--json` | emit machine-readable JSON instead of human output |
| `-q, --quiet` | suppress progress output on stderr |

## Profiles

Multiple servers / accounts are supported via named profiles. The active
profile is resolved from `--url`/`--token`, then `--profile` /
`$CROWI_PROFILE`, then the stored current profile.

## Commands

Auth / lifecycle: `login`, `logout`, `whoami`, `profiles`. Read: `search`,
`get` (alias `cat`), `ls`. Write: `create`, `edit`, `update`, `mv`, `rm`.
Phase 2 (need extra scopes): `comment`, `attach`, `bookmark`, `watch`, `open`.

## Output formats & scripting

`search` and `ls` accept `--format` and `--template` so their output can be
shaped for piping:

| Flag | Effect |
| --- | --- |
| `--json` (global) | dump the full raw response as JSON |
| `--format human` | default human rendering (one readable row per record) |
| `--format table` | aligned columns with a header row |
| `--format template` | one templated line per record |
| `--template '<tpl>'` | implies template mode; `{{field}}` placeholders per record |

The template language is intentionally tiny: `{{path}}` is replaced by the
record's `path`; dotted paths walk nested objects (`{{page.path}}`); missing
fields render empty; `\t` / `\n` in the template expand to a tab / newline. So:

```bash
# tab-separated path + score, one hit per line
crowi search "release notes" --template '{{path}}\t{{score}}'
```

`get` reads a page reference from stdin when given `-`, so search output can
feed straight into a fetch:

```bash
crowi search onboarding --template '{{path}}' | head -1 | crowi get - > onboarding.md
```

## Shell completion

`crowi completion <bash|zsh|fish>` prints a completion script generated from
the live command tree (so it never drifts from the registered commands):

```bash
# bash
eval "$(crowi completion bash)"
# zsh
crowi completion zsh > "${fpath[1]}/_crowi"
# fish
crowi completion fish > ~/.config/fish/completions/crowi.fish
```

## Server compatibility (version skew & capabilities)

Crowi is self-hosted, so the `crowi` binary and the server it talks to can be
on different versions. The CLI reads the public `GET /api/v2/app/info` signal
(`version` / `apiVersion` / `capabilities`) and caches it on the profile for a
few minutes.

The policy is **warn-only — the CLI never refuses a command over a version or
capability mismatch**:

- Requests are validated against the bundled request contracts (the "v2 floor")
  before they are sent, but responses are parsed leniently, so extra or missing
  fields from a newer / older server do not break a command.
- If the server's API surface differs from the one this CLI targets, a one-line
  skew note is printed to stderr and the command continues.
- A command whose feature the server does not advertise (e.g. `search` when no
  search backend is configured) prints a clear "not available on this server"
  message instead of surfacing a raw error.
- An older server that predates capability reporting (no `version` /
  `capabilities` fields) is treated as the always-on baseline with skew warnings
  suppressed, so it keeps working silently.

All of these notes go to stderr, so `--json` stdout stays clean for scripts.

## Single-file binary

`pnpm --filter @crowi/cli build:binary` produces a standalone `crowi`
executable under `packages/cli/dist/` using Node's native Single Executable
Application (SEA) support. The step bundles everything (commander +
`@crowi/api-contract`) into `dist/bin.sea.js`, generates the SEA blob, copies
the `node` binary, and injects the blob with `postject` (fetched via `npx`).

Notes:
- Requires `postject` (pulled on demand) and, on macOS, `codesign` to re-sign
  the patched binary.
- The browser-based `login` flow (`open`) is unavailable inside the SEA binary;
  use `crowi login --device` from the single-file build.
