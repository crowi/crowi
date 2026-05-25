---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

ページ一覧 (`/...slug.../`, `/`) の可視性と表示を 2 点修正:

- **root / no-path 分岐の grant フィルタを修正**: 旧実装は
  `grant: { $in: [1, 2] }` でハードコードしており、(a) 閲覧者自身の
  GRANT_OWNER / GRANT_SPECIFIED ページが落ち、(b) grantedUsers 未チェック
  のため GRANT_RESTRICTED ページが非メンバーにも漏れる懸念があった。
  Page model の `visiblePageGrantOr` / `visiblePageStatusOr` を `$and` で
  組み合わせる形に揃え、path 系の listing と振る舞いを統一。
- **draft ページの視覚的識別**: `PageStatusSchema` に `'draft'` を追加
  (path 系 listing には RFC-0004 で閲覧者自身の draft が含まれていたが、
  contract enum に無いため status フィールドが TypeScript 上で表現できず
  バッジを出せなかった)。`PageListItem` に amber の「下書き」バッジを
  追加。これで自分の draft が published と並んでいても一目で区別できる。
