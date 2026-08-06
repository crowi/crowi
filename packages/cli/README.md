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
| `attach` (list/add/download) | `attachments:read attachments:write` |
| `bookmark` (get/list/add/remove) | `bookmarks:read bookmarks:write` |
| `watch` (get/set) | none — rides the default `pages:*` |

`--scope` is validated against the server's issuable catalog before any request
leaves your machine, so a typo or a reserved `admin:*` scope fails fast.

If you run a command whose scope your token does not carry, the request still
reaches the server and comes back `403 INSUFFICIENT_SCOPE`; the CLI turns that
into an actionable hint and exits non-zero (code `3`):

```console
$ crowi comment add /onboarding -m "looks good"
crowi: your token lacks the required scope — re-login granting it: `crowi login --scope "comments:write"`
```

`--scope` **replaces** the default set, so include `pages:read pages:write` if
you still want the page commands — or request the umbrella `read write`, which
the server expands to every issuable `*:read` / `*:write`:

```bash
crowi login https://wiki.example.com --scope "pages:read pages:write comments:read comments:write"
crowi login https://wiki.example.com --scope "read write"   # everything issuable
```

See [Errors & exit codes](#errors--exit-codes) for the full exit-code table.

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

`-p, --profile <alias>` works either before or after the command name on
every command (`crowi login <url> --profile work` and `crowi --profile work
login <url>` both work); once it's after the command name it also works
either before or after a positional argument like `<url>` (`crowi login
--profile work <url>` too — `--profile` isn't tied to the argument
position). When given on both sides of the command name, the command-side
value wins. Switch the current profile (the default used when `--profile`
is omitted) with `crowi profiles use <alias>`:

```bash
crowi login --profile work https://wiki.example.com
crowi profiles use work
crowi search "release notes"   # runs against work, no --profile needed
```

An unknown alias leaves the config untouched and exits `4` (`no such
profile: <alias>`, see [Errors & exit codes](#errors--exit-codes)).

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
on different versions. The CLI reads the public `GET /api/app/info` signal
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

## Errors & exit codes

Errors print as `crowi: <message>` on stderr and set a non-zero exit code, so
scripts can branch on the failure class. The message is mapped from the API
error envelope (`error.code` / `error.message`); a few cases get a friendlier,
actionable hint (e.g. an insufficient scope tells you exactly which `--scope`
to re-login with, and a `409` edit conflict tells you to re-run with `--force`).

| Code | Name | When |
| --- | --- | --- |
| `0` | success | command completed |
| `1` | general | uncategorised failure / network error |
| `2` | not signed in | no profile or no usable token — run `crowi login` |
| `3` | forbidden | token lacks the required scope (`403 INSUFFICIENT_SCOPE`) — re-login with `--scope` |
| `4` | not found | page / resource does not exist (`404`) |
| `5` | conflict | optimistic-lock edit conflict (`409`) — re-run `edit`/`update` with `--force` to overwrite |
| `6` | invalid | bad arguments / client-side validation (`400` / `422`) |
| `7` | unavailable | server unavailable, or the feature is not enabled on this instance (`503`) |

`edit` and `update` send the page's `revision_id` for optimistic locking; if the
page changed while you were editing, the write returns `5` (conflict) and aborts
rather than clobbering — re-run with `--force` to overwrite the newer revision.

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
