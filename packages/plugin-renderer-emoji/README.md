# @crowi/plugin-renderer-emoji

Emoji shortcode renderer for Crowi 2.x. Replaces `:smile:` /
`:rocket:` / `:thumbs_up:` style shortcodes with their Unicode emoji
counterparts via [`remark-emoji`](https://github.com/rhysd/remark-emoji).

No I/O. No cache. Pure text-level transform.

## What it does

Given a page body containing `Hello :smile: world!`, the plugin
rewrites the paragraph's text nodes so the rendered output is
`Hello 😄 world!`.

Known shortcodes come from `node-emoji`'s standard list (the GitHub
shortcode set + Unicode CLDR aliases). Unknown shortcodes
(`:not-emoji:`) pass through verbatim — no user-visible breakage on
typos.

### Skipped content

- **Fenced code blocks** (` ```...``` `) — `:smile:` inside a code
  fence stays as `:smile:`.
- **Inline code** (`` `:smile:` ``) — same.

This is `remark-emoji`'s default — it walks `text` nodes inside
phrasing content but never descends into `code` / `inlineCode`.

### Accessibility

The plugin enables `accessible: true`, which wraps each emoji in
`<span role="img" aria-label="<name>">`. Screen readers announce
the emoji's CLDR name rather than reading the raw codepoint.

## Install

Bundled in the Crowi monorepo:

```bash
pnpm --filter @crowi/api add -D @crowi/plugin-renderer-emoji
# or in a standalone runner:
npm install @crowi/plugin-renderer-emoji
```

## Configure

### Enable in `crowi.config.json`

```jsonc
{
  "plugins": [
    "@crowi/plugin-renderer-emoji"
  ]
}
```

A server restart is required for plugin-list changes.

### Per-plugin config

None — the defaults (`accessible: true`, `emoticon: false`,
`padSpaceAfter: false`) are baked in at registration time. If you
need to tune them, the plugin is small enough to fork (Phase 6
keeps the API minimal; per-plugin admin UI extension is Phase 7+).

## Default on/off matrix

| Install kind                | Recommended | How to apply         |
|-----------------------------|-------------|----------------------|
| **Fresh Crowi 2.x install** | ON          | List in `plugins`.   |
| **Migrated v1 install**     | ON          | Same as fresh; emoji shortcodes worked in v1 via `emojify.js` so existing content continues to render. |

## Out of scope (Phase 6)

- Skin-tone modifiers / ZWJ sequences (`:family_woman_woman_girl_boy:`)
  — node-emoji's standard shortcode set only. Compound emojis can
  still be typed as Unicode directly.
- Custom emoji upload (à la Slack) — Phase 7+.
- Per-org / per-page enable toggle — Phase 7+.

## See also

- [`remark-emoji`](https://github.com/rhysd/remark-emoji) — upstream
  remark plugin.
- [`node-emoji`](https://github.com/omnidan/node-emoji) — shortcode
  → Unicode table this plugin transitively consumes.
