---
name: crowi-migration
description: |
  Crowi 2.0 移行ワークフロー。Express/Swig から Next.js + Hono への移行時に自動適用。
  キーワード: migrate, 移行, Express, Swig, legacy, 旧実装
globs:
  - "packages/api/src/hono/**"
  - "packages/api-contract/src/**"
  - "packages/web/src/app/**"
---

# Crowi 2.0 Migration Skill

Crowi の旧 Express + Swig + jQuery を、新 Hono API + Next.js に段階的に置き換える。
1人開発・main 直コミット運用が前提。

> 注: 旧 Express/Swig レイヤーと中間の ts-rest 実装は RFC-0006 (2026-05-22 main マージ)
> で完全撤去済み。core wiki 機能の移行はほぼ完了しており、この skill は主に残作業・
> 新規エンドポイント追加の参照用。

## 実態のアーキテクチャ

```
crowi/                            # Turborepo + pnpm workspace
├── apps/crowi-site/              # crowi.wiki LP + docs (移行対象外)
├── crowi.config.json             # dev runner config (plugins + active drivers)
├── .env(.example)                # dev runtime env (repo root で読まれる)
└── packages/
    ├── api/                      # Hono API (port 4301)
    │   └── src/
    │       ├── hono/             # ★ Hono app: handlers/ (admin/ 含む) + middleware/ + app.ts
    │       ├── models/           # Mongoose
    │       ├── crowi/            # boot sequence
    │       └── util/             # helpers
    ├── api-contract/             # Hono (@hono/zod-openapi) + Zod 契約 (src/{contracts,schemas})
    ├── web/                      # Next.js 16 App Router (port 4302)
    │   └── src/app/
    │       ├── (public)/         # ログイン前
    │       ├── (auth)/           # ログイン後 (jwtAuth)
    │       └── (admin)/          # 管理画面 (jwtAdminRequired)
    ├── runner/                   # config loader + plugin resolver (api boot で使用)
    ├── collab/                   # Hocuspocus 協調編集ホスト (RFC-0003)
    ├── admin-cli/                # `crowi-admin` CLI
    └── plugin-*/                 # storage / renderer / search プラグイン
```

エンドポイントは `packages/api/src/hono/handlers/` に集約。旧 `controllers/` / `routes/`
/ `views/` は撤去済みで存在しない。

## 技術スタック

- API: **Hono** v4 + `@hono/zod-openapi` + Mongoose + JWT (jwtAuth middleware)
- Web: **Next.js 16** (App Router, Turbopack) + React 19 + Tailwind v4 + shadcn/ui + tanstack/react-query
- 共通: TypeScript 5.x strict, pnpm workspace, Turborepo

## 移行パターン

### 旧 Express controller → Hono ハンドラ

ページ作成 (`POST /api/v2/pages`) を例に:

```typescript
// packages/api-contract/src/contracts/page.ts — @hono/zod-openapi の route 定義
export const createPageRoute = createRoute({
  method: 'post',
  path: '/pages',
  tags: ['page'],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreatePageRequestSchema } } } },
  responses: {
    200: { description: 'Created page', content: { 'application/json': { schema: PageWithRevisionSchema } } },
    400: { description: 'Bad request', content: { 'application/json': { schema: ApiErrorSchema } } },
  },
});

// packages/api/src/hono/handlers/page.ts — route を openapi() で登録
export const registerPageRoutes = (app, crowi) => {
  app.use('/pages/*', createJwtAuth(crowi));
  return app.openapi(createPageRoute, async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');
    const created = await Page.createPage(body.path, body.body, user, { grant: body.grant });
    return c.json({ page: pageToResponse(created) }, 200);
  });
};
```

### 旧 Swig → Next.js

```html
<!-- 旧: packages/api/views/page/list.html -->
{% for page in pages %}<div>{{ page.path }}</div>{% endfor %}
```

```tsx
// 新: packages/web/src/app/(auth)/[[...slug]]/page.tsx
'use client';
const { data } = useQuery(['pages'], () => client.page.listPages());
return data?.body.pages.map(p => <div key={p._id}>{p.path}</div>);
```

## ワークフロー

```
/migrate {feature}

planner ──→ implementer ──→ simplify ──→ reviewer ─┬→ committer
                ↑                          ↑       │
                └─────── NEEDS_WORK ───────┴───────┘
```

各 phase の責務:

- **planner**: 旧実装の場所特定、既存の Hono 契約の有無を必ず確認、task ファイル作成
- **implementer**: 実装 + テスト、最後に必須チェック (type-check / test / lint / format) を全部走らせる
- **simplify**: `simplify` skill を呼び、reuse / quality / efficiency を整える
- **reviewer**: 契約整合・旧実装互換・テスト網羅・セキュリティを確認
- **committer**: ローカルコミット (デフォルト main-direct モードでブランチ作らず main へ)

## state 管理

- ディレクトリ: **`.migration-state/` (リポジトリ root)** ※ `.claude/migration-state/` ではない
- gitignore 済み (中身はローカルのみ、`.gitkeep` のみ tracked)
- `queue.json`: アクティブタスクとグローバル config
- `tasks/{task-id}.json`: 各タスクの真実 (status はここが正)

### queue.json スキーマ

```json
{
  "currentTask": "migrate-pages-create",
  "config": {
    "commitStrategy": "main-direct",
    "maxReviewAttempts": 3,
    "runSimplify": true
  },
  "lastUpdated": "2026-05-05T..."
}
```

`tasks/` に存在するファイルが真実。`queue.json` に各タスク status を二重で持たせない。

### task ファイルスキーマ (`tasks/{id}.json`)

```json
{
  "id": "migrate-pages-create",
  "name": "ページ作成 API の移行",
  "status": "PLANNED",
  "context": {
    "oldImpl": [
      "packages/api/src/controllers/page.ts:554-583 (api.create)",
      "packages/api/src/routes/api/page.ts:10"
    ],
    "newImpl": [
      "packages/api/src/hono/handlers/page.ts (createPage)"
    ],
    "contracts": [
      "packages/api-contract/src/contracts/page.ts (createPage)",
      "packages/api-contract/src/schemas/page.ts (CreatePageRequestSchema)"
    ],
    "models": ["packages/api/src/models/page.ts"],
    "relatedPRs": ["#894", "#896"],
    "architecturalNotes": "authenticatedRouter で jwtAuth 適用済み、CSRF 不要"
  },
  "acceptanceCriteria": ["..."],
  "openQuestions": ["..."],
  "history": [
    {"phase": "planner", "at": "...", "by": "agent"},
    {"phase": "implementer", "at": "...", "by": "agent"}
  ]
}
```

`context` は planner が埋め、後続 agent はそれを読むだけで作業できる(プロンプトでの補完不要)。

## ステータス遷移

```
PLANNED → IN_PROGRESS → REVIEW → (APPROVED → COMMITTED) | NEEDS_WORK → IN_PROGRESS → ...
```

`commitStrategy: main-direct` では COMMITTED で完結 (CI 監視・DONE 遷移なし)。

## 起動例

```
# 新規移行
/migrate pages.update

# 計画だけ
Use migration-planner to plan: pages.update

# 個別 phase
Use migration-implementer to implement: migrate-pages-update
Use migration-reviewer to review: migrate-pages-update
Use migration-committer to commit: migrate-pages-update
```

## Crowi テーマ

```css
--crowi-primary: #43676b;
--crowi-header: #263a3c;
--crowi-sidebar: #f8f9fa;
```
