# @crowi/plugin-slack

Slack integration for Crowi 2.0. **Phase 1 (link unfurling)**: when a
Crowi page link is shared in Slack, the bot replaces it with a rich
preview (title, excerpt, breadcrumb, last-updated). Public pages only —
non-public pages render a minimal "🔒 Restricted page" card with no
contents.

See [RFC-0013](https://github.com/crowi/crowi/blob/main/docs/rfcs/0013-slack-plugin.md)
for the full design, and the operator setup guide at
`apps/crowi-site/content/docs/{ja,en}/operations/slack.mdx`.

## What it provides

- **Config** (`@sensitive`, encrypted at rest): `botToken` (`xoxb-…`) and
  `signingSecret`.
- **"Generate Slack App manifest"** admin button (`@action`): returns the
  Slack App manifest JSON to paste into Slack's "create app from manifest"
  flow, pre-filled with this instance's inbound URL, the `link_shared`
  bot event, the wiki host as the unfurl domain, and least-privilege OAuth
  scopes (`links:read`, `links:write`, `chat:write`).
- **Inbound webhook** `POST /api/v2/plugins/@crowi/plugin-slack/events`
  (public; authenticated by Slack's request signature, not a Crowi
  session): verifies the HMAC signature (with a ±5-minute replay guard),
  echoes the `url_verification` challenge, and unfurls `link_shared`
  events asynchronously (idempotent under Slack's retries).

## Setup

1. Add `@crowi/plugin-slack` to your runner project's `package.json` and
   to `crowi.config.json`'s `plugins`.
2. In the admin UI (Slack settings, under Notifications), click
   **Generate Slack App manifest** and copy the JSON.
3. Create a Slack App from that manifest, install it to your workspace.
4. Paste the **Bot User OAuth token** and **Signing secret** into the
   admin form and save. `reconfigure` rebuilds the Slack client live.
5. Share a public Crowi page link in Slack — it unfurls.

### Dev tunnel

Slack cannot reach `localhost`. In development, run a tunnel
(ngrok / cloudflared) and set `SLACK_MANIFEST_REQUEST_URL` to its public
origin (e.g. `https://abc123.ngrok.app`); the generated manifest's
`request_url` is built from it. When unset, the manifest falls back to
`CLIENT_URL`.

## Scope

Phase 1 is unfurl-only. Slash commands / interactivity (Phase 2) and the
notifier driver (Phase 3) are tracked separately in RFC-0013.
