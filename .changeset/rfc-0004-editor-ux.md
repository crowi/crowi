---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Editor UX enhancement (RFC-0004) v2.2 が利用可能に。RFC-0003 で導入した
最小構成の CodeMirror 6 エディタに、エディタを「使える」から「生産的」へ
引き上げる 4 機能を追加した。

主な機能:

- **入力補完 (autocomplete)**: `@` + 文字でユーザー、`[[` + 文字で
  ページの候補ドロップダウンが cursor 下に出る。display / insert / view
  の 3 分離 (挿入は `@username` / `[[/full/path]]` の正規形)、100ms
  debounce、LRU キャッシュ + footer の Refresh、コードブロック / 数式 /
  リンク構文内とモバイル幅では抑制
- **paste ハンドラ**: 単一 URL の paste を `[text](url)` / autolink へ
  smart 変換、画像 blob は `pasted-<ts>.<ext>` 自動命名で
  `POST /api/v2/attachments/upload` へアップロード、`![Uploading…(%)…]()`
  プレースホルダを Yjs トランザクションで in-place 進捗更新
- **ドラッグ&ドロップアップロード**: ファイルドロップでカーソル位置に
  進捗付きアップロード + 参照挿入 (画像 `![](url)` / その他 `[](url)`)、
  複数ファイル直列処理、read-only モードでは無効化
- **下書き (draft) ページ**: 新規ページが `Page.status: 'draft'` で始まり
  保存で `'published'` へ一方向遷移。`POST/GET/DELETE /api/v2/pages/drafts`、
  同一パス競合は 409 + owner 情報、`/me/creating-pages` 管理ビュー。
  draft は author 限定で listing / search / collab から除外
- **toast 通知ユーティリティ**: 上記が共有する `notify.info/warn/error`
  の最小実装

`@crowi/api-contract` の minor bump は autocomplete / drafts /
attachment-upload の新契約と、`Page` schema への `status` field 追加に
よるもの。アップロードはレート制限 20/min/user・サイズ上限
(paste 10MB / D&D 50MB)・ファイル種別 allow-list を強制する。

利用者向けの使い方は `apps/crowi-site/content/docs/ja/guide/`
(`attachments.mdx` / `pages.mdx` / `markdown.mdx`)、運用者向けの
アップロード制限は `apps/crowi-site/content/docs/ja/operations/storage.mdx`、
設計判断は `docs/rfcs/0004-editor-ux-enhancement.md` を参照。
