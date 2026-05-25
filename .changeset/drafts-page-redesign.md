---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

`/me/creating-pages` (作成中のページ) を情報設計から見直し。下書きは
未公開の triage 対象 — 「何を書きかけだったか」「進捗しているか」
「残すか捨てるか」を一目で判断できることを優先し、行構造とアクション
を組み直した。

- `DraftSummary` に `bodyPreview` (先頭 80 文字を whitespace 折り畳み)
  と `bodyLength` (本文文字数) を追加。drafts 一覧ハンドラが latest
  revision の body を populate して埋める。
- 行レイアウトは 3 行構成: パス + 文字数バッジ / 本文プレビュー (未記入
  時は淡色で「(未記入)」) / 開始日時 · 最終編集日時。`updatedAt` は
  従来未使用だったのを利用、ただし作成直後 (1 分以内) は冗長なので
  省略する。
- 行右端のアクションはアイコン専用の Ghost ボタン 2 つ (編集 / キャンセル)。
  従来のラベル付き Outline ボタン 2 つから行の高さを大きく削った。
- 「新しいページを始める」フォームを Card+Header+Description+Body の
  重い構造から、ヘッダー右の「+ 新規ページ」ボタンで開閉する軽量
  インラインパネルに変更。H1 subheading とフォームの説明文が同一文を
  二重表示していた問題も解消。
