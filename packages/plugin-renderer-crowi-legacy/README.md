# @crowi/plugin-renderer-crowi-legacy

Crowi v1 互換挙動の集約プラグイン。

このプラグインは、Crowi 1.x で受け入れられていた **CommonMark 準拠ではない
v1 独自の Markdown 書き癖** を、Crowi 2.x でも従来どおりレンダリングできる
ようにするためのものです。Crowi 1.x からデータを移行してきた場合のみ有効化
してください。

> ※ 「シングル改行 → `<br>`」については当初このプラグインで提供していまし
> たが、GitHub・GitLab・Slack 等の主要 Markdown サーフェスと同じ挙動 (= GFM
> 互換) であり、CommonMark 純正の soft-break のほうがむしろ少数派であるため、
> **Crowi 2.x のデフォルト挙動 (core pipeline)** に格上げされました。
> 改行のためにこのプラグインを入れる必要はもうありません。

## このプラグインが直す v1 挙動

| 入力 | プラグイン無効 (素の CommonMark) | プラグイン有効 |
|---|---|---|
| `##hoge` | 段落 `##hoge` (見出しにならない) | 見出し depth 2 `hoge` |
| `###bar` | 段落 `###bar` | 見出し depth 3 `bar` |
| `#######nope` (7 個以上) | 段落のまま | 段落のまま (CommonMark 仕様尊重) |
| `## hoge` | 見出し depth 2 `hoge` | 見出し depth 2 `hoge` (二重変換しない) |

ATX 見出しの `#` の直後に空白を入れない、という非エンジニアに多かった v1 時代
の書き癖を補正します。CommonMark / GFM 仕様では `#` のあとに必ず空白が必要
なため、素のパーサだと段落扱いになり見出しスタイルがつきません。

## このプラグインがやらないこと

- **H1 → ページタイトル抽出** — v1 は本文の最初の H1 をページタイトルとし
  て採用していました。Crowi 2.x はタイトルを `Page.path` で別管理しています。
- **`@include` / `@toc` 等の独自トークン** — Crowi 2.x のプラグインモデルに
  置き換えられています。該当ページは手動で書き直してください。
- **`</path/to/page>` 山括弧内部リンク** — `crowi-admin migrate
  --only=wikilink` で `[[...]]` 表記に一括変換できます (本プラグインの責務
  ではない)。
- **添付 URL (`/_uploads/...`) の書き換え** — Crowi 2.x の `LinkDetector` が
  そのままハンドルするため不要。

## 既知の制約

- このプラグインによって書き換えられた `##hoge` 見出しは、**TOC (目次) には
  表示されません**。また、**heading anchor (`#hoge` 形式の見出し ID)** も
  付きません。理由: コアの見出し処理 (TOC + slug 計算) はプラグインより前に
  走るため、後段でパラグラフ → 見出しに変換しても TOC ビルダはもう動いて
  いないためです。
- 長期的には、移行元の本文を `##hoge` → `## hoge` (空白入り) に書き直すこと
  を推奨します。

## インストール / 有効化

ランナー (`crowi.config.json` を置いているディレクトリ) の `package.json`
依存に追加し、`crowi.config.json` の `plugins` に列挙します:

```bash
npm install @crowi/plugin-renderer-crowi-legacy
# or dev:
pnpm --filter @crowi/api add -D @crowi/plugin-renderer-crowi-legacy
```

```jsonc
{
  "plugins": [
    "@crowi/plugin-renderer-crowi-legacy"
  ]
}
```

サーバの再起動が必要です (`crowi.config.json` は起動時に読まれます)。

### Default on/off matrix

| Install kind | Recommended | 適用方法 |
|---|---|---|
| **新規 Crowi 2.x install** | OFF (`plugins` から外す) | 通常通りの GFM レンダリングになる |
| **Crowi 1.x からの移行 install** | ON (`plugins` に列挙) | v1 時代の書き癖を v2 でも崩さない |

設定 (環境変数) は一切ありません。`plugins` に列挙するか否かのみが ON/OFF
スイッチです。

### 管理画面

`/admin/plugins` には `Crowi v1 互換レンダラー` というラベルで表示されます。
プラグインごとの個別設定項目はありません。

## 既存ページの再レンダリング

このプラグインを有効化すると、以後 **編集して保存し直したページ** の
`Revision.renderedAst` にはプラグインの効果が反映されます。**既存の
renderedAst (旧 revision)** はプラグイン無効時に生成済みなので、自動的に
は書き換わりません。一括再レンダリングは将来の `crowi-admin
renderer:rebuild` で対応予定です。

## See also

- RFC-0002 — Crowi 2.0 renderer architecture と Phase 5 (v1 compat migrator)
  の全体像。
- core pipeline (`packages/api/src/renderer/pipeline.ts`) — 改行 → `<br>` を
  含む Crowi 2.x デフォルト挙動はこちらに統合済み。
