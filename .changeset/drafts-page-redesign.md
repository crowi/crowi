---
'@crowi/web': minor
---

`/me/creating-pages` (作成中のページ) を情報設計から見直し。下書きは
未公開の triage 対象 — 「これは生きてる作業か」「残すか捨てるか」を
一目で判断できることを優先し、行構造とアクションを組み直した。

- 行レイアウトは 2 行構成: パス (mono / 編集画面への Link) /
  開始日時 · 最終編集日時。`updatedAt` は従来未使用だったのを利用、
  ただし作成直後 (1 分以内) は冗長なので省略する。`Page.updatedAt` は
  Hocuspocus の compaction store で更新されるので Yjs 編集中も
  ちゃんと進む。
- 行右端のアクションはアイコン専用の Ghost ボタン 2 つ (編集 / キャンセル)。
  従来のラベル付き Outline ボタン 2 つから行の高さを大きく削った。
- 「新しいページを始める」フォームを Card+Header+Description+Body の
  重い構造から、ヘッダー右の「+ 新規ページ」ボタンで開閉する軽量
  インラインパネルに変更。H1 subheading とフォームの説明文が同一文を
  二重表示していた問題も解消。

本文プレビュー / 文字数の表示は見送り: draft 本文は Hocuspocus 上の
Y.Doc / `Page.yjsState` が真のソースで、`Page.revision.body` には
明示 save 時しか反映されない。listing から Y.Doc を再構築すれば
正確に出せるが、コストが見合わないので 2 行構成に留めた。
