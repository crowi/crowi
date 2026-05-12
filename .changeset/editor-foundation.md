---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Markdown editor を CodeMirror 6 ベースに刷新、2 column live preview を復活。
`/_edit` ページが viewport 幅の専用 layout で、左にエディタ・右にプレビュー
(狭幅では Tabs 切替) という配置になり、入力に対して 250ms debounce で
プレビューが追従する。プレビューはサーバー側 renderer pipeline
(`POST /api/v2/pages/preview`) を経由するため、ページ表示と同じ mdast →
React 経路で描画され、編集中と保存後の見た目が完全に一致する。

`MarkdownEditor` は controlled component (`value` / `onChange` / `readonly`
/ `extraExtensions`) として実装。`extraExtensions` 口は将来の
realtime collab (RFC-0003) で `yCollab` 拡張を挿し込むための土台。
