---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Page presence & header UI (RFC-0005) v2.2 が利用可能に。ページ閲覧画面に
「いま誰が見ているか」をリアルタイム表示するライブプレゼンス行を追加し、
ヘッダーのメタ行を統一されたクリック可能チップに再構成した。

主な機能:

- **ライブプレゼンス行**: ページタイトルの上に、いまそのページを開いて
  いるユーザーのアバターをリアルタイム表示。リアルタイム共同編集の
  エディタを開いている人には `✏️` バッジが付く。最大 5 アバター + `[+N]`
  ポップオーバー (20 件 cap)、自分は「(あなた)」ラベル付き。自分しか
  いないときは行ごと非表示、狭い画面では `[👁 N]` チップ → シート展開。
  新規参加は 3 秒の anti-flicker 遅延で滑らかに反映
- **メタチップ行の再構成**: 作成者/更新時刻の静的要素 +
  いいね / 閲覧 / コメント / バックリンクの 4 つを `[アイコン][数][ラベル]`
  の統一クリック可能チップに変換。いいね・閲覧はモーダル、コメント・
  バックリンクは該当セクションへ smooth scroll + heading focus。count=0 は
  グレーアウト + 非インタラクティブ + ツールチップ。いいねボタン押下で
  チップ count を optimistic 更新 (失敗時 toast で revert)
- **「いいねした人」モーダル**: 既存の「閲覧した人」モーダルと同形の
  新規モーダル。v1.x の閲覧者アバタースタックは廃止し、閲覧チップ +
  モーダルに置き換え
- **presence WebSocket / エンドポイント**: `GET /api/v2/pages/:id/presence-token`
  (短命 JWT 発行) と `/presence/:pageId` WebSocket を新設。WebSocket は
  RFC-0003 の `/collab` と同じく api プロセスの `http.Server` に
  `ws noServer` モードで attach され、別プロセス・別ポートは不要。
  ビューア状態は Redis hash、マルチインスタンス伝搬は Redis pub/sub で
  既存 Redis を共用 (専用インフラなし)。`isEditing` は RFC-0003 の
  editor-cap Set と broadcast 時に join して算出

`@crowi/api-contract` の minor bump は新エンドポイント
(`GET /pages/:id/presence-token` / `GET /pages/:id/likers`) と presence
WebSocket メッセージ schema の追加によるもの。

利用者向けの使い方は `apps/crowi-site/content/docs/{ja,en}/guide/pages.mdx`、
運用者向けの `/presence/*` リバースプロキシ注記は
`apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx`、
設計判断は `docs/rfcs/0005-page-presence.md` を参照。
