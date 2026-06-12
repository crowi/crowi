# @crowi/plugin-search-mongo

## 0.1.0-alpha.0

### Minor Changes

- f56fd9b: Added a new plugin `@crowi/plugin-search-mongo`, an infra-free search backend that needs nothing but MongoDB. Adding the plugin name to `plugins[]` in `crowi.config.json` and setting `search.driver: 'mongo'` makes search run as a live MongoDB `$regex` query over page path / title / body, so small-to-mid deployments can use full-text-ish search without standing up Elasticsearch or OpenSearch.

  The driver is grant-aware (anonymous viewers see public pages only; non-admin viewers see public pages plus their own and pages granted to them; admins see everything; draft / deleted / redirect pages are always excluded), and supports `pageType` (portal / public / user), `pathPrefix` filtering and paging (`page` / `limit`, capped at 200). Because it queries live data there is no index to build or maintain: `index()` / `remove()` are no-ops. Body matches are resolved against the current revision in a bulk pass with a candidate cap to keep collection scans bounded; this is positioned for small-to-mid wikis, while large deployments should keep using the Elasticsearch / OpenSearch plugins.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
