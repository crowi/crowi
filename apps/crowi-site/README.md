# @crowi/site — crowi.wiki

[crowi.wiki](https://crowi.wiki) のソース。Crowi のランディングページとドキュメントを 1 つの Next.js 16 アプリとして配信する。

## スタック

- **Next.js 16** (App Router, static export)
- **Tailwind CSS v4** + Crowi テーマ (`packages/web` と同じトークン)
- **Fumadocs UI** (Docs 部分の TOC / sidebar / 検索)
- **i18n**: `ja` (default) と `en`、`[lang]` セグメントベース

## ディレクトリ

```
apps/crowi-site/
├── content/docs/{ja,en}/**.mdx     # Docs ソース (guide / operations / develop / reference の 4 タブ)
├── source.config.ts                # Fumadocs MDX
├── src/
│   ├── app/
│   │   ├── layout.tsx              # html/body
│   │   ├── page.tsx                # / → /<browser-locale-or-default>
│   │   └── [lang]/
│   │       ├── layout.tsx          # I18nProvider + RootProvider
│   │       ├── (home)/page.tsx     # LP
│   │       └── docs/[[...slug]]/   # Fumadocs page
│   ├── components/
│   ├── dictionaries/{ja,en}.json   # LP コピー
│   └── lib/
│       ├── i18n.ts
│       ├── source.ts
│       ├── layout-options.tsx
│       ├── dictionaries.ts
│       └── utils.ts
└── public/_redirects               # Cloudflare Pages
```

## 開発

```bash
pnpm --filter @crowi/site dev      # http://localhost:4303
pnpm --filter @crowi/site build    # → out/
pnpm --filter @crowi/site preview  # build + ローカル静的サーバ
```

## デプロイ (Cloudflare Pages)

`pnpm --filter @crowi/site build` の出力先は `out/`。

Wrangler を使う場合:

```bash
pnpm --filter @crowi/site build
npx wrangler pages deploy apps/crowi-site/out --project-name=crowi-wiki
```

GitHub 連携で自動デプロイする場合:

| 設定項目 | 値 |
| --- | --- |
| Build command | `pnpm install && pnpm --filter @crowi/site build` |
| Build output directory | `apps/crowi-site/out` |
| Root directory | `/` |

## ドキュメント追加

Docs は読者別の 4 タブ (Fumadocs の root フォルダ) に分かれている。

| タブ | フォルダ | 読者 | 中身 |
| --- | --- | --- | --- |
| ガイド | `content/docs/<locale>/guide/` | 利用者 | 導入と利用者向けの手順 |
| 管理と運用 | `content/docs/<locale>/operations/` | 管理者・運用者 | インストール・設定・管理画面・保守 |
| 開発 | `content/docs/<locale>/develop/` | 開発者・コントリビュータ | アーキテクチャ・開発環境・プラグイン開発・SDK 参照 |
| リファレンス | `content/docs/<locale>/reference/` | 全員 | 一覧表だけ。表と 1 行の説明で構成し、手順と理由は書かない |

1. 読者に対応するフォルダに `<slug>.mdx` を作る。**ja / en の両方**を揃えると言語スイッチャーが自然に動作する。
2. 同じフォルダの `meta.json` の `pages` にスラッグを追加する。未登録のページはサイドバーに出ない。タブ内のグループ見出しは `"---名前---"` のセパレータで書く。
3. フォルダの入口ページは `index.mdx` として置く (URL はフォルダ自身 `/docs/operations`)。`meta.json` にも `"index"` として登録し、他のページからは `../operations` のようにフォルダの URL でリンクする — `./index` は URL として存在しないのでリンクチェッカが弾く。
4. ページを移動・改名したら `public/_redirects` に 301 を足し、リンク元の相対リンクを張り替える。
5. `pnpm --filter @crowi/site check:links` で相対リンクが解決するか確認する (リポジトリルートの `pnpm lint` からも走る)。
6. `node scripts/check-docs-vocabulary.mjs` で、`guide/` `operations/` `reference/` に RFC 番号・spec id・リポジトリのパス・内部の識別子が入っていないか確認する (同じく `pnpm lint` から走る)。正当な出現は `scripts/docs-vocabulary-allow.json` に `{path, pattern, why}` で登録する。

環境変数・設定キー・CLI オプションのような一覧表は `reference/` の該当ページに 1 か所だけ置き、手順ページはそこへリンクする。表を 2 か所に置かない。

概念の呼び名を増やす・変えるときは `scripts/docs-glossary.json` を先に直す。用語 lint はこのファイルからルールを起こし、`content/docs/<locale>/reference/glossary.mdx` に canonical 語が現れることを `pnpm test:scripts` が assert するので、データとページのどちらか片方だけを直すと落ちる。

`index.mdx` の `<Card href>` は locale 込みの絶対パス (`/ja/docs/reference/env`) で書く。`Card` は href をそのままリンクコンポーネントへ渡すため相対パスは解決されず、`check:links` が JSX の href 属性を検証して弾く。

読者と文書タイプによる置き場所の決め方・書いてよい内容の規約は [crowi-docs-refresh skill](../../.claude/skills/crowi-docs-refresh/SKILL.md) にある。
