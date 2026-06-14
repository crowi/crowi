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

Command implementations land incrementally (login / whoami / search / get /
ls / create / edit / rm / mv first, then comment / attach / bookmark / watch).
