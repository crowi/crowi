# @crowi/plugin-search-mongo

The default, **infra-free** search driver for Crowi 2.0. It searches live
data — the `Page` collection and each page's current `Revision` — with a
case-insensitive MongoDB `$regex` over **path / title / body**. No external
service, no separate search index: MongoDB alone powers search.

This is what makes the slim deployment (local file storage + mongo search)
searchable out of the box, with MongoDB as the only required infrastructure.

## When to use

- ✅ Small / mid-size wikis that don't want to run Elasticsearch / OpenSearch.
- ✅ Japanese (and other CJK) content: a `$regex` substring match is more
  practical than MongoDB `$text`, whose CJK tokenisation is weak.
- ❌ Large installs. A non-anchored `$regex` cannot use an index, so search
  scans the collection. Run
  [`@crowi/plugin-search-elasticsearch`](../plugin-search-elasticsearch)
  instead at scale.

## How it works

- **No index maintenance.** `index()` and `remove()` (called from the
  page-saved hook) are no-ops; there is nothing to keep in sync because the
  page body already lives in `Page` / `Revision`. `rebuild()` is omitted.
- **Two-pass query.** Path/title hits (the page title is its path) are
  found first, then body hits are resolved via a single bulk
  `Revision.find({ revision: { $in }, body: regex })` over the
  viewer-visible candidate pages (capped at `CANDIDATE_CAP = 5000` to bound
  the scan). Path hits rank ahead of body-only hits.
- **Grant-aware.** Results respect page visibility: anonymous viewers see
  public pages only, admins see everything, and other viewers see public
  pages plus pages they created or that are shared with them. Drafts,
  deleted pages and redirects are always excluded.
- **Snippets.** Best-effort substring around the first match, with the
  match wrapped in `<mark>`. Not HTML-escaped — the web client sanitises
  before render.

## Configuration

None. The driver uses the same MongoDB connection as the rest of the app,
so its `configSchema` is empty. Select it with `search.driver: 'mongo'` in
the runner's `crowi.config.json` (this is the schema default).
