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
├── content/docs/{ja,en}/**.mdx     # Docs ソース (guide / operations / develop の 3 タブ)
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

Docs は読者別の 3 タブ (Fumadocs の root フォルダ) に分かれている。

| タブ | フォルダ | 読者 |
| --- | --- | --- |
| ガイド | `content/docs/<locale>/guide/` | 利用者 |
| 管理と運用 | `content/docs/<locale>/operations/` | 管理者・運用者 |
| 開発 | `content/docs/<locale>/develop/` | 開発者・コントリビュータ |

1. 読者に対応するフォルダに `<slug>.mdx` を作る。**ja / en の両方**を揃えると言語スイッチャーが自然に動作する。
2. 同じフォルダの `meta.json` の `pages` にスラッグを追加する。未登録のページはサイドバーに出ない。タブ内のグループ見出しは `"---名前---"` のセパレータで書く。
3. ページを移動・改名したら `public/_redirects` に 301 を足し、リンク元の相対リンクを張り替える。
4. `pnpm --filter @crowi/site check:links` で相対リンクが解決するか確認する (リポジトリルートの `pnpm lint` からも走る)。

読者と文書タイプによる置き場所の決め方・書いてよい内容の規約は [crowi-docs-refresh skill](../../.claude/skills/crowi-docs-refresh/SKILL.md) にある。
