---
"@crowi/plugin-slack": minor
---

The inbound Slack webhook URL this plugin's "Generate Slack App manifest" button generates (and that you may already have pasted into Slack's Event Subscriptions "Request URL" field) moves from `/api/v2/plugins/@crowi/plugin-slack/events` to `/api/plugins/@crowi/plugin-slack/events`, following the api-wide `/api/v2` → `/api` prefix cutover. Unlike the renderer stylesheet manifest path, this URL is not validated/normalized by the receiving API — it is purely a string an operator copies into Slack's own configuration. After upgrading `@crowi/api` past the cutover (coordinated fleet drain/restart, see the "api prefix cutover" section in the self-hosting docs), regenerate the manifest from the admin UI or manually update the Request URL in your Slack App's Event Subscriptions settings, or inbound events will 404.
