# @crowi/site — crowi.wiki

[crowi.wiki](https://crowi.wiki) のソース。Crowi のランディングページとドキュメントを 1 つの Next.js 16 アプリとして配信する。

## スタック

- **Next.js 16** (App Router, static export)
- **Tailwind CSS v4** + Crowi テーマ (`apps/crowi-web` と同じトークン)
- **Fumadocs UI** (Docs 部分の TOC / sidebar / 検索)
- **i18n**: `ja` (default) と `en`、`[lang]` セグメントベース

## ディレクトリ

```
apps/crowi-site/
├── content/docs/{ja,en}/**.mdx     # Docs ソース
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
pnpm --filter @crowi/site dev      # http://localhost:3401
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

`content/docs/<locale>/<slug>.mdx` を作成し、`content/docs/<locale>/meta.json` の `pages` 配列に追加する。両言語に対応するページを揃えると言語スイッチャーが自然に動作する。
