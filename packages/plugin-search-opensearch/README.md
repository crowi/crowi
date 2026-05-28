# @crowi/plugin-search-opensearch

OpenSearch search driver for Crowi 2.0. Indexes pages on create /
update / delete, serves the wiki search box, and rebuilds the whole
index from scratch on demand. Targets a `<indexName>-current` alias so
a rebuild can swap the underlying index atomically.

The plugin is a sibling of [`@crowi/plugin-search-elasticsearch`](../plugin-search-elasticsearch):
the wire-level document shape, alias name, mapping JSONs and query DSL
are identical, so a cluster migration between the two backends is a
re-point + rebuild rather than a mapping rewrite.

## Install

```bash
crowi-admin plugin add @crowi/plugin-search-opensearch
```

(or, in dev: `pnpm --filter @crowi/api add -D @crowi/plugin-search-opensearch`)

## Configure

### 1. Activate the driver in `crowi.config.json`

```jsonc
{
  "plugins": ["@crowi/plugin-search-opensearch"],
  "search": { "driver": "opensearch" }
}
```

A server restart is required when `search.driver` changes — Crowi
reads this file once at boot.

### 2. Fill in connection settings in the admin UI

Open `/admin/plugins` and edit `@crowi/plugin-search-opensearch`:

- **`url`** — `https://[user:pass@]host[:port][/indexName]`. The URL
  embeds the cluster password, so it is encrypted at rest with
  `CROWI_ENCRYPTION_KEY`. Only Basic Auth via the URL is supported
  (AWS SigV4 / IAM auth is intentionally out of scope; a managed
  OpenSearch deployment using fine-grained access control still works
  with a Basic Auth user).
- **`indexName`** — base index name (default `crowi`). The driver
  reads / writes the `<indexName>-current` alias.
- **`requestTimeout`** — per-request timeout in ms (default `5000`).
- **`analyzer`** — `default` / `kuromoji` / `sudachi` (see below).

The admin UI is the single source of truth for these settings — there
is no env-variable fallback.

### 3. Build the initial index

```bash
crowi-admin search rebuild
```

This creates a fresh `<indexName>-<timestamp>-<rand>` index, indexes
all pages in 2000-document bulk batches with pre-fetched bookmark
counts, and atomically swaps `<indexName>-current` to the new index.

## Hot-reload (no restart needed)

This plugin implements `reconfigure`, so **saving connection settings
in the admin UI applies without a server restart**. When you save:

- the `url` / `indexName` / `requestTimeout` / `analyzer` changes are
  picked up by the live driver,
- a fresh OpenSearch client is built and the previous one is closed
  in the background (its HTTP keep-alive pool drains),
- the admin UI shows a "saved — applied immediately" toast.

Mechanics: the driver holds a module-scope state ref; each operation
(`query` / `index` / `remove` / `rebuild`) snapshots the state once at
the top of the call, so a save that lands mid-request cannot retarget
an inflight operation onto a different cluster. The next request sees
the new settings.

### Caveats

- **Analyzer changes need a manual rebuild.** Switching `analyzer`
  (`default` / `kuromoji` / `sudachi`) updates the setting immediately,
  but the **existing index keeps its old analyzer** — analyzers are
  fixed at index-creation time. Run `crowi-admin search rebuild` to
  create a new index with the new analyzer and swap the alias to it.
- **Empty `url` → configured `url` is restart-only.** If `url` was
  empty at boot, the driver is not registered and there is nothing for
  `reconfigure` to mutate; configure a `url` and restart once. After
  that, all further changes hot-reload. Clearing a configured `url`
  (configured → empty) *is* handled live — search requests then fail
  with a clear `Search not configured` error until a `url` is set again.
- A rebuild that is already running when you reconfigure runs to
  completion against the cluster / index name it started with.

## Analyzer flavours

| Analyzer | Cluster requirement |
|---|---|
| `default` | No extra OpenSearch plugin. |
| `kuromoji` | `analysis-kuromoji` (Apache 2.0, from `opensearch-project/analysis-kuromoji`). Unlike Elasticsearch, this is a **separate distribution** from OpenSearch core — install it on every cluster node with `bin/opensearch-plugin install analysis-kuromoji` and restart. |
| `sudachi` | Third-party `analysis-sudachi` (OpenSearch-compatible fork from WorksApplications) + a dictionary. Operators must bundle these into a custom image. Picking this without the plugin makes `rebuild()` fail. |

For a wiki with mostly Japanese content, `kuromoji` is the typical
choice. The mapping JSON (`src/mappings/kuromoji.json`) names the
analyzer as `kuromoji`, which is the identifier both the Elastic and
OpenSearch distributions install under, so no per-engine tweak is
needed in the mapping itself.

## Trying it locally

The default `docker compose` stack ships an **Elasticsearch** service
for the sibling plugin, not OpenSearch. To exercise this plugin
locally, add an override file:

```yaml
# compose.override.yml
services:
  opensearch:
    image: opensearchproject/opensearch:2.18.0
    environment:
      - discovery.type=single-node
      - plugins.security.disabled=true
      - OPENSEARCH_INITIAL_ADMIN_PASSWORD=Crowi-Dev-Passw0rd!
    ports:
      - "9201:9200"
```

Then:

1. `docker compose up -d opensearch` — brings up OpenSearch on `:9201`
   (`:9200` is taken by the dev Elasticsearch service if you left it
   running).
2. In `/admin/plugins`, set `@crowi/plugin-search-opensearch`'s `url`
   to `http://opensearch:9201/crowi` (or `http://localhost:9201/crowi`
   from outside the compose network) and save; restart once if the
   driver was previously unconfigured.
3. From `/admin/search`, run a rebuild to populate the index.
4. Change `requestTimeout` (or point `indexName` at a freshly rebuilt
   index) and save **without restarting**. The next search query uses
   the new settings — confirmed by the api log line
   `reconfigured opensearch search driver (...)`.

## Why a separate plugin from `@crowi/plugin-search-elasticsearch`?

Both backends speak the same query DSL today, but the SDKs differ
(`@opensearch-project/opensearch` vs `@elastic/elasticsearch`) and the
backends are intentionally allowed to diverge — OpenSearch's neural /
k-NN extensions, the Elastic-licensed features in newer ES versions,
and the analyzer-plugin distribution stories are all separate concerns.
Keeping the drivers in distinct npm packages means each can pin its own
SDK / mapping fork without forcing the other to follow.

The parse-query / query-builder / mapping JSON files are 1:1 copies of
the ES plugin's today, but **on purpose** — we will revisit a shared
core when a third driver arrives.

## See also

- [`@crowi/plugin-search-elasticsearch`](../plugin-search-elasticsearch) —
  the sibling Elasticsearch driver.
- RFC-0001 §"Search" for the search-driver plugin architecture.
- [`@crowi/plugin-storage-aws-s3`](../plugin-storage-aws-s3) — the
  reference implementation of the same state-ref + snapshot hot-reload
  pattern.
