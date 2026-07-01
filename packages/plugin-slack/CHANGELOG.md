# @crowi/plugin-slack

## 0.1.0-alpha.0

### Minor Changes

- 2f70464: New `@crowi/plugin-slack`: rich link unfurling of public Crowi pages in Slack.
  Generates a Slack App manifest from admin, verifies inbound Slack request
  signatures, handles the Events API `url_verification` handshake, and unfurls
  `link_shared` for public pages (title / breadcrumb / excerpt / updated-at);
  non-public pages render a locked placeholder with no body.

### Patch Changes

- Updated dependencies [66f1de2]
- Updated dependencies [e9aad03]
  - @crowi/plugin-api@0.1.0-alpha.2
