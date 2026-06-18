# crowi/docker-elasticsearch

Elasticsearch with Japanese text-analysis plugins baked in, for self-hosting
the [Crowi](https://crowi.wiki) wiki's Elasticsearch search backend
(`@crowi/plugin-search-elasticsearch`).

> This is a community-built, self-host-oriented redistribution. It is **not an
> official Elastic product** and is **not endorsed by, affiliated with, or
> certified by Elasticsearch B.V.** "Elasticsearch" is used descriptively
> (nominative use) to identify the bundled upstream software. The upstream
> `LICENSE.txt` / `NOTICE.txt` are retained inside the image. **This is not
> legal advice** — operators are responsible for confirming license compliance
> for their use.

## Variants

| Variant | Tag | Contents |
| --- | --- | --- |
| **kuromoji** (default) | `crowi/docker-elasticsearch:<es>` | Elasticsearch + `analysis-kuromoji` (Elastic-distributed). Lightweight. |
| **sudachi** | `crowi/docker-elasticsearch:<es>-sudachi` | The above **plus** `analysis-sudachi` (WorksApplications) + the SudachiDict **core** dictionary (adds ~tens of MB). |

Both variants are published as multi-arch manifests (`linux/amd64`,
`linux/arm64`).

## Tags

- **Immutable**: `:<es>` (kuromoji) and `:<es>-sudachi` — e.g. `:9.4.1`,
  `:9.4.1-sudachi`. These never move once published.
- **Moving**: `:9` (kuromoji, the default variant — no suffix; `:9-kuromoji` is
  published as an alias) and `:9-sudachi` track the latest 9.x build of each
  variant.

```sh
# kuromoji (default)
docker pull crowi/docker-elasticsearch:9.4.1
docker pull crowi/docker-elasticsearch:9          # latest 9.x kuromoji

# sudachi (kuromoji + sudachi + core dictionary)
docker pull crowi/docker-elasticsearch:9.4.1-sudachi
docker pull crowi/docker-elasticsearch:9-sudachi  # latest 9.x sudachi
```

## Supported Elasticsearch versions (sudachi variant)

`analysis-sudachi` must match the Elasticsearch **patch** version **exactly**.
With `analysis-sudachi` **v3.6.0**, the available ES 9.x patch builds are:

| Elasticsearch | analysis-sudachi |
| --- | --- |
| 9.0.8 | 3.6.0 |
| 9.1.10 | 3.6.0 |
| 9.2.8 | 3.6.0 |
| 9.3.4 | 3.6.0 |
| **9.4.1** (default) | 3.6.0 |

The kuromoji variant is not patch-constrained (the plugin is installed via
`elasticsearch-plugin install analysis-kuromoji` and tracks the base image),
but the published default tracks the same ES patch as the sudachi variant for
consistency.

## Build args

Both Dockerfiles are parameterized so a build can be re-pinned without editing
the file:

| Build arg | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `ES_VERSION` | both | `9.4.0` (kuromoji) / `9.4.1` (sudachi) | Base Elasticsearch version (patch-exact for sudachi). |
| `SUDACHI_PLUGIN_VERSION` | sudachi | `3.6.0` | `WorksApplications/elasticsearch-sudachi` release tag. |
| `SUDACHIDICT_VERSION` | sudachi | `20260428` | SudachiDict core release date. |
| `DICT_SHA256` | sudachi | _(empty)_ | Optional SudachiDict zip checksum to verify the (HTTP) download. |

```sh
# kuromoji (context = repo root)
docker build -f elasticsearch.Dockerfile \
  --build-arg ES_VERSION=9.4.1 \
  -t crowi/docker-elasticsearch:9.4.1 .

# sudachi (context = ./elasticsearch)
docker build -f elasticsearch/Dockerfile.sudachi \
  --build-arg ES_VERSION=9.4.1 \
  --build-arg SUDACHI_PLUGIN_VERSION=3.6.0 \
  --build-arg SUDACHIDICT_VERSION=20260428 \
  -t crowi/docker-elasticsearch:9.4.1-sudachi ./elasticsearch
```

Images are published from CI by the `docker-elasticsearch.yml` workflow
(`workflow_dispatch` with `es_version` / `sudachi_plugin_version` /
`dict_version` / `variant` inputs, or an `es-v<es>` tag push). This workflow is
**completely independent** of the Crowi `release.yml` / `docker.yml` — ES images
are cut on their own cadence (ES upgrades, plugin/dictionary updates, ES
security patches).

## Bundled licenses

The image aggregates each component's notices in
`/usr/share/elasticsearch/CROWI-NOTICE.txt`, and retains the upstream
Elasticsearch `LICENSE.txt` / `NOTICE.txt`.

- **Elasticsearch 9.x** — offered under AGPLv3 / Elastic License 2.0 (ELv2) /
  SSPL. This image is a **self-host** redistribution permitted under ELv2:
  - do **not** offer it to third parties as a managed/hosted service,
  - do **not** circumvent the license-key functionality,
  - do **not** remove or obscure Elastic licensing/branding.
- **analysis-kuromoji** — distributed by Elastic; same license as the base
  image.
- **analysis-sudachi** (WorksApplications) — Apache License 2.0.
- **SudachiDict** core (WorksApplications) — Apache License 2.0, with notices
  for derived source corpora (e.g. UniDic / NINJAL).

See `elasticsearch/NOTICE` in the repository for the full text.
