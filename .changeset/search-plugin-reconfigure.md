---
'@crowi/plugin-search-elasticsearch': minor
---

Elasticsearch search plugin が config の hot-reload に対応。admin UI で ES の
接続 URL / indexName / analyzer / requestTimeout を変更して保存すると、サーバー
を再起動しなくても次の検索クエリから新しい設定が反映される。

plugin に `reconfigure(ctx)` を実装し、driver を state-ref + snapshot 構造へ
書き換えた。設定変更時は全フィールドを作り直して state を入れ替え、旧 ES Client
は keep-alive pool を drain するため fire-and-forget で `close()` する。設定変更
中に走っている検索リクエストは開始時の snapshot を見続けるため一貫性が保たれる。
`PluginInfo.supportsHotReload` が `true` になり、admin UI に「即時反映されました」
トーストが表示される。

注意: analyzer を変更した場合、既存 index は古い analyzer のままなので新しい
analyzer を有効化するには手動 rebuild が必要 (詳細は plugin README を参照)。
