---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Realtime collaborative editing (RFC-0003) v2.1 alpha が利用可能に。
ページ編集画面 (`/_edit?page_id=<pageId>`) が Google Docs 風の
リアルタイム共同編集モードで動作するようになり、複数ユーザーが同時に
同じページを編集できる。Hocuspocus を `@crowi/collab` library として
api プロセス内に同居 attach する構成で出荷しており、`/collab/*`
WebSocket は api と同じホストで処理される (別プロセス起動は不要)。

`@crowi/api-contract` の minor bump は `GET /api/v2/pages/:id/yjs-token`
(wsToken 発行) と `Revision` schema の `savedBy` / `contributors`
field 追加によるもの。

主な機能:

- Live cursors / awareness 表示で他メンバーのカーソル位置と選択範囲
  をリアルタイムに可視化。`Alice (with Bob, Carol)` 形式の contributors
  表示も revision history に追加
- Save = checkpoint モデル: 明示的な保存ボタンで `Revision` を生成、
  autosave は意図的に無し。`Revision.prepareRevision` (RFC-0002) を
  経由して renderedAst も同時更新
- 同時編集者上限 20 (`COLLAB_MAX_EDITORS_PER_PAGE` で変更可)。
  21 人目以降は read-only モードで live update を受信
- Multi-instance deployment では `@hocuspocus/extension-redis` が
  `REDIS_URL` 設定時に自動 attach、sticky session 不要のまま全 api
  レプリカで pub/sub
- 永続化は 3 層構造: `Page.yjsState` (live snapshot) / `PageYjsUpdate`
  (TTL 1h の高頻度差分) / `Revision` (save 時のチェックポイント)

運用手順 (リバースプロキシ設定 / multi-instance 必須 env /
2-instance smoke test) は `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx`、
利用者向けの使い方は `apps/crowi-site/content/docs/{ja,en}/realtime-editing.mdx`、
設計判断は `docs/rfcs/0003-realtime-collaborative-editing.md` を参照。
