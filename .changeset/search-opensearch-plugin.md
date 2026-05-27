---
'@crowi/plugin-search-opensearch': minor
'@crowi/plugin-search-elasticsearch': minor
---

OpenSearch を検索バックエンドとして使うための新プラグイン
`@crowi/plugin-search-opensearch` を追加。`crowi.config.json` の `plugins[]`
にプラグイン名を追加し `search.driver: 'opensearch'` を指定すると、
`@opensearch-project/opensearch` を経由して OpenSearch クラスタを検索バックエンド
として使える。挙動は `@crowi/plugin-search-elasticsearch` と同等で、
state-ref + snapshot による hot-reload、`<indexName>-current` alias を使った
atomic rebuild、`default` / `kuromoji` / `sudachi` の 3 アナライザを提供する。
AWS SigV4 認証は未対応 (Basic Auth ベースの url のみ)。analysis-kuromoji は
OpenSearch では別 distribution として配布されるため、operator は
`bin/opensearch-plugin install analysis-kuromoji` で別途インストールする必要が
ある (README 参照)。

あわせて、`@crowi/plugin-search-elasticsearch` の `onInstall` (`ELASTICSEARCH_URI`
/ `BONSAI_URL` 環境変数から plugin config namespace `url` への自動移行) を廃止。
両 plugin の設定経路を admin UI 1 本に統一する。Crowi 2.0 は alpha 開発中で
本番未投入のため後方互換 fallback は持たず、operator は admin UI で url を
設定 → `crowi-admin search rebuild` で初回 index を構築するフローに揃える。
これに合わせて `.env.example` / `docker-compose.yml` / 関連ドキュメントから
`ELASTICSEARCH_URI` の記述を削除した。
