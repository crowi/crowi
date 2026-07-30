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
- **Inbound webhook** `POST /api/plugins/@crowi/plugin-slack/events`
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

### Upgrading past the `/api/v2` → `/api` prefix cutover

If you already installed this plugin and registered a Slack App **before**
your Crowi instance's coordinated `/api/v2` → `/api` cutover (see
"api prefix cutover" in the self-hosting operations guide), the inbound
webhook URL Slack has on file is now stale — after the cutover, `@crowi/api`
no longer serves `/api/v2/*` at all, so events silently stop arriving
(Slack's retries eventually fail and it may disable the Event Subscription).
This is a manual, operator-side step; Crowi cannot update Slack's
configuration for you. Once your runner has upgraded `@crowi/api` past the
cutover, do one of the following:

- Click **Generate Slack App manifest** again in the admin UI and paste the
  regenerated JSON into your existing Slack App (App Manifest tab), or
- Manually edit your Slack App's **Event Subscriptions → Request URL** to
  `https://<your-host>/api/plugins/@crowi/plugin-slack/events` and re-verify
  it (Slack re-sends the `url_verification` challenge on save).

New installs created after the cutover already get the canonical
`/api/plugins/...` URL from the generated manifest and need no follow-up.

## Scope

Phase 1 is unfurl-only. Slash commands / interactivity (Phase 2) and the
notifier driver (Phase 3) are tracked separately in RFC-0013.
