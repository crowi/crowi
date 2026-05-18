# @crowi/plugin-search-elasticsearch

Elasticsearch 9 search driver for Crowi 2.0. Indexes pages on create /
update / delete, serves the wiki search box, and rebuilds the whole
index from scratch on demand. Targets a `<indexName>-current` alias so
a rebuild can swap the underlying index atomically.

## Install

```bash
crowi-admin plugin add @crowi/plugin-search-elasticsearch
```

(or, in dev: `pnpm --filter @crowi/api add -D @crowi/plugin-search-elasticsearch`)

## Configure

### 1. Activate the driver in `crowi.config.json`

```jsonc
{
  "plugins": ["@crowi/plugin-search-elasticsearch"],
  "search": { "driver": "elasticsearch" }
}
```

A server restart is required when `search.driver` changes — Crowi
reads this file once at boot.

### 2. Fill in connection settings in the admin UI

Open `/admin/plugins` and edit `@crowi/plugin-search-elasticsearch`:

- **`url`** — `https://[user:pass@]host[:port][/indexName]`. The URL
  embeds the cluster password (Bonsai-style), so it is encrypted at
  rest with `CROWI_ENCRYPTION_KEY`. The legacy `ELASTICSEARCH_URI` /
  `BONSAI_URL` env values are migrated into this field on first install.
- **`indexName`** — base index name (default `crowi`). The driver
  reads / writes the `<indexName>-current` alias.
- **`requestTimeout`** — per-request timeout in ms (default `5000`).
- **`analyzer`** — `default` / `kuromoji` / `sudachi` (see below).

## Hot-reload (no restart needed)

This plugin implements `reconfigure`, so **saving connection settings
in the admin UI applies without a server restart**. When you save:

- the `url` / `indexName` / `requestTimeout` / `analyzer` changes are
  picked up by the live driver,
- a fresh Elasticsearch client is built and the previous one is closed
  in the background (its HTTP keep-alive pool drains),
- the admin UI shows a "saved — applied immediately" toast.

Mechanics: the driver holds a module-scope state ref; each operation
(`query` / `index` / `remove` / `rebuild`) snapshots the state once at
the top of the call, so a save that lands mid-request cannot retarget
an inflight operation onto a different cluster. The next request sees
the new settings.

### Caveats

- **Analyzer changes need a manual rebuild.** Switching `analyzer`
  (`default` ↔ `kuromoji` ↔ `sudachi`) updates the setting immediately,
  but the **existing index keeps its old analyzer** — Elasticsearch
  analyzers are fixed at index-creation time. Run a full rebuild from
  `/admin/search` (or the rebuild action) to create a new index with
  the new analyzer and swap the alias to it.
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
| `default` | No extra Elasticsearch plugin. |
| `kuromoji` | `analysis-kuromoji` plugin (Elastic-distributed). The dev image (`elasticsearch.Dockerfile`) preinstalls it. |
| `sudachi` | Third-party `analysis-sudachi` plugin + dictionary. **Not** bundled in the dev image — operators must build a derived image. Picking this without the plugin makes `rebuild()` fail. |

## Verifying hot-reload in dev

The dev `docker compose` stack includes an Elasticsearch service, so
you can exercise the hot-reload path end to end:

1. `docker compose up -d` — brings up mongo / redis / elasticsearch.
2. `pnpm dev` — starts api + web.
3. In `/admin/plugins`, set `@crowi/plugin-search-elasticsearch`'s
   `url` to `http://elasticsearch:9200/crowi` and save; restart once if
   the driver was previously unconfigured.
4. From `/admin/search`, run a rebuild to populate the index.
5. Change `requestTimeout` (or point `indexName` at a freshly rebuilt
   index) and save **without restarting**. The next search query uses
   the new settings — confirmed by the api log line
   `reconfigured elasticsearch search driver (...)`.

## See also

- RFC-0001 §"Search" for the migration story from the legacy ES7 indexer.
- [`@crowi/plugin-storage-aws-s3`](../plugin-storage-aws-s3) — the
  reference implementation of the same state-ref + snapshot hot-reload
  pattern.
