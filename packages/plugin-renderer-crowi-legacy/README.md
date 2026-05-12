# @crowi/plugin-renderer-crowi-legacy

Crowi v1 compatibility renderer for Crowi 2.x. Re-enables the v1
"Markdown Fixer" behaviour where a **single newline** in a page body
renders as a hard line break (`<br>`) instead of a CommonMark
soft-break.

Crowi 2.x defaults to CommonMark semantics (single newlines are
whitespace, blank lines split paragraphs). Operators upgrading an
existing Crowi 1.x install with pages that rely on the old behaviour
can enable this plugin to preserve the visual layout of legacy
content without rewriting any pages.

## Install

The plugin is bundled in the Crowi monorepo. Operators add it to their
runner project the same way they add any other plugin:

```bash
# in your runner directory (the one with crowi.config.json)
npm install @crowi/plugin-renderer-crowi-legacy
# or, in dev:
pnpm --filter @crowi/dev-runner add @crowi/plugin-renderer-crowi-legacy
```

## Configure

### Enable in `crowi.config.json`

```jsonc
{
  "plugins": [
    "@crowi/plugin-renderer-crowi-legacy"
  ]
}
```

A server restart is required for plugin-list changes to take effect —
Crowi reads `crowi.config.json` once at boot.

### Default on/off matrix

| Install kind | Recommended | How to apply |
|---|---|---|
| **Fresh Crowi 2.x install** | OFF (omit from `plugins`) | Don't list the plugin. Single newlines render as soft-breaks, matching CommonMark. |
| **Migrated Crowi 1.x → 2.x install** | ON (list in `plugins`) | List the plugin to keep v1's `<br>` behaviour for existing pages. |

This plugin does not currently read environment variables — the only
on/off knob is whether you list it in `crowi.config.json:plugins`.

### Admin UI

Once listed in `crowi.config.json`, the plugin appears in
`/admin/plugins` with the label "Crowi v1 互換レンダラー". There are
no per-plugin config fields to fill in — the plugin is either enabled
(listed) or not (omitted).

## Re-rendering existing pages

When you enable this plugin against a Crowi instance that already has
content, the **stored `Revision.renderedAst`** of old pages was
computed without `remark-breaks` and therefore still emits soft-breaks
on read. The plugin's effect kicks in only when a page is **re-saved**
(creating a new revision) or **re-rendered** by an admin batch job.

For Phase 5, the supported workflow is:

1. Enable the plugin in `crowi.config.json` + restart the API.
2. Operators / authors edit a page → save → the new revision's
   `renderedAst` includes the `break` nodes.

A future Phase 5.1 may ship `crowi-admin renderer:rebuild` to refresh
every revision's `renderedAst` in bulk; that is **not** part of Phase 5.

## What this plugin does NOT do

This is intentionally a narrow compatibility shim. Out of scope:

- **H1 → page title extraction** — v1 used the first H1 in a body as
  the page title. v2 stores titles in a separate `Page.path` field and
  does not infer titles from body content. Migration of existing H1
  titles is handled per-page by operators.
- **PHP-style include / Crowi-specific tokens** — v1 supported a few
  custom syntaxes (`@include`, `@toc`, etc.) that have been replaced by
  v2's plugin model. Operators with content depending on those should
  edit the affected pages.
- **`</path/to/page>` angle-bracket internal links** — v1 supported a
  shorthand for internal page links. Use the `crowi-admin migrate --only=wikilink`
  command (also part of Phase 5) to rewrite these to v2's
  `[[/path/to/page]]` wikilink syntax.
- **Attachment URL (`/_uploads/...`) migration** — v2's `LinkDetector`
  already handles these URLs natively, so no migration is required.

## See also

- RFC-0002 §"Phase 5 — v1 compatibility migrator" for the migration
  rationale and the wikilink-rewrite CLI.
- [`remark-breaks`](https://github.com/remarkjs/remark-breaks) — the
  upstream plugin this one wraps.
