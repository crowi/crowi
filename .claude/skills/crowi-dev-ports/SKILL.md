---
name: crowi-dev-ports
description: >-
  並行 worktree の dev ポート割当・dev portal (:4300)・reverse proxy・tailscale
  serve・DB isolation の仕組みと運用。`pnpm dev` のポートが読めない / 実機
  (iPhone 等) から確認したい / collab や presence が繋がらない / worktree ごとに
  DB を分けたい / migrate apply が worktree で拒否される、といったときに読む。
  固定ポートのツールを追加するとき (4300-4999 帯を避ける必要がある) にも参照。
  キーワード: dev port, ポート, portal, proxy, caddy, tailscale, 実機確認,
  mobile, isolateDb, DB 分離, anchor, 4300, collab 繋がらない
---

# Crowi dev ports / portal / tailscale

`pnpm dev` auto-detects the worktree and assigns each one a deterministic
4-port block (stride 10): `api = anchor`, `web = anchor+1`, `site = anchor+2`,
`proxy = anchor+3`. `main` is pinned to `anchor 4301` (today's ports, no
migration); every other worktree gets the next free block starting at 4310,
recorded in `~/.crowi-dev-ports.json` (outside the repo, shared across every
worktree checkout) so the same worktree always gets the same anchor. Pin one
explicitly with `pnpm dev --anchor 4350`. **Fixed-port tooling must stay outside
this `4300-4999` band** or it clashes with a worktree's block — e.g. the e2e
servers sit just below at `4290`/`4291` (`packages/e2e/src/config.ts`).

- **The proxy (`anchor+3`) is the canonical dev entry point**, not the raw web
  port. `pnpm dev` fronts api + web + the collab/presence/notifications
  WebSocket namespaces behind one same-origin reverse proxy (Caddy if
  installed, otherwise a zero-dep node fallback — see `scripts/dev-caddy.mjs`),
  the same routing table as the prod front proxy (`Caddyfile`). This is what
  lets realtime editing work at all: Next's `rewrites()` is HTTP-only and
  can't forward a WS `upgrade`, so opening the web port directly skips the
  proxy and collab/presence/notifications won't connect (see the doc comment
  in `packages/web/src/lib/resolve-ws-url.ts`).
- **tailscale serve** publishes only the proxy port (`tailscale serve --bg
  --https=<anchor+3> localhost:<anchor+3>`) so an iPhone/other Mac on the same
  tailnet can open `https://<your-machine>.<tailnet>.ts.net:<anchor+3>` and get
  full realtime editing without restarting `pnpm dev`. Requires tailnet
  HTTPS/MagicDNS enabled; missing/not-logged-in `tailscale` just warns and
  continues (localhost still works). Ctrl-C / closing a worktree only turns
  off *that* worktree's serve (`--https=<anchor+3> off` — never `tailscale
  serve reset`, which would also drop every other worktree's proxy).
- **The dev portal** is a read-only dashboard on a fixed `:4300` listing every
  live worktree (from `git worktree list`) with its up/down status (proxy port
  probe), reachable proxy URLs (localhost + this host's LAN/tailscale IPs + the
  tailscale MagicDNS URL, rendered as a mobile-friendly card layout), and DB
  (shared vs. isolated). It's a separate long-lived process so restarting one
  worktree doesn't take the portal down for the others, and self-GCs registry
  entries for worktrees that no longer exist. **The main worktree's `pnpm dev`
  auto-starts it** (main is the always-around home base; feature worktrees rely
  on main's). Run it standalone with `pnpm dev:portal`, or opt main out with
  `CROWI_DEV_NO_PORTAL=1`. Both the portal and each worktree's proxy bind
  `0.0.0.0`, so they're reachable by IP (`http://<ip>:4300` /
  `http://<ip>:<anchor+3>`) from a phone on the tailnet or LAN even without the
  `tailscale` CLI (dev-only; also LAN-exposed, an accepted tradeoff).
- **DB isolation is opt-in and mongo-only** (redis/ES always stay shared —
  redis's URL parser ignores the db-number path segment, and both are
  ephemeral state). Add `dev.local.json` at the worktree root (gitignored):
  `{ "isolateDb": true }`, or pass `--isolate-db`; the mongo DB name becomes
  `crowi_<key>` instead of the shared one. `pnpm migrate apply` (the only
  destructive migrate subcommand — `--dry-run`/`plan`/`status` are exempt)
  refuses to run from a non-main worktree against the shared DB unless you
  isolate it, pass `--yes`, or set `CROWI_MIGRATE_FORCE=1` (non-interactive
  environments fail closed instead of hanging on a prompt).
- Implementation lives in `scripts/dev-ports.mjs` (registry/lock/key
  normalization), `scripts/dev-caddy.mjs` (proxy config generation + fallback),
  `scripts/dev-portal/` (the dashboard), and the `scripts/dev.mjs` /
  `scripts/migrate.mjs` extensions that wire them together.
