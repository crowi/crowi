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

```bash
crowi login https://wiki.example.com          # browser auth-code + PKCE
crowi login --device https://wiki.example.com # headless / SSH
```

The default scope is `pages:read pages:write`. Pass `--scope '<space list>'`
to request more (e.g. `comments:read comments:write` for the comment
commands).

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
