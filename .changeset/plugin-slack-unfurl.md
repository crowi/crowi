---
'@crowi/plugin-slack': minor
---

New `@crowi/plugin-slack`: rich link unfurling of public Crowi pages in Slack.
Generates a Slack App manifest from admin, verifies inbound Slack request
signatures, handles the Events API `url_verification` handshake, and unfurls
`link_shared` for public pages (title / breadcrumb / excerpt / updated-at);
non-public pages render a locked placeholder with no body.
