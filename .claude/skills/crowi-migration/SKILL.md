---
name: crowi-migration
description: |
  Crowi 2.0 移行ワークフロー。Express/Swig から Next.js + ts-rest への移行時に自動適用。
  キーワード: migrate, 移行, Express, Swig, legacy, 旧実装
globs:
  - "apps/crowi-api/src/controllers/**"
  - "apps/crowi-api/src/routes/**"
  - "apps/crowi-api/views/**"
---

# Crowi 2.0 Migration Skill

Crowi の旧 Express + Swig + jQuery を、新 ts-rest API + Next.js に段階的に置き換える。
1人開発・main 直コミット運用が前提。

## 実態のアーキテクチャ

```
crowi/
├── apps/
│   ├── crowi-api/              # Express + ts-rest, port 3000
│   │   ├── src/
│   │   │   ├── controllers/    # 旧実装(Swig render)
│   │   │   ├── routes/
│   │   │   │   ├── api/        # 旧 /_api/* (HTTP RPC)
│   │   │   │   ├── admin.ts    # 旧管理画面
│   │   │   │   ├── login.ts    # 旧ログインフォーム
│   │   │   │   ├── me.ts       # 旧マイページ
│   │   │   │   └── ts-rest/    # ★ 新実装はここ
│   │   │   ├── models/         # Mongoose
│   │   │   └── middlewares/
│   │   └── views/              # ★ 旧 Swig テンプレート(置き換え対象)
│   └── crowi-web/              # Next.js 16, port 3301
│       └── src/app/
│           ├── (public)/       # ログイン前
│           └── (auth)/         # ログイン後 (jwtAuth)
└── packages/
    └── api-contract/           # ts-rest + Zod 契約
        └── src/{contracts,schemas}/
```

旧実装と新実装は同じ apps/crowi-api リポジトリに同居している。lib/ ディレクトリは存在しない。

## 技術スタック

- API: **Express** v4 + ts-rest v3 + Mongoose + JWT (jwtAuth middleware)
- Web: **Next.js 16** (App Router, Turbopack) + React 19 + Tailwind v4 + shadcn/ui + tanstack/react-query
- 共通: TypeScript 5.x strict, pnpm workspace, Turborepo

## 移行パターン

### 旧 Express controller → ts-rest

旧 `controllers/page.ts` の `actions.api.create` を例に:

```typescript
// 旧: apps/crowi-api/src/routes/api/page.ts
router.post('/pages.create', AccessTokenParser, LoginRequired, csrf, Page.api.create);

// 新: packages/api-contract/src/contracts/page.ts (既存に追加)
export const pageContract = c.router({
  createPage: {
    method: 'POST',
    path: '/pages',
    body: CreatePageRequestSchema,
    responses: { 200: PageWithRevisionSchema, 400: ApiErrorSchema },
  },
});

// 新: apps/crowi-api/src/routes/ts-rest/page.ts
createPage: async ({ body, req }) => {
  const user = req.user;
  const created = await Page.createPage(body.path, body.body, user, { grant: body.grant });
  return { status: 200, body: { page: pageToResponse(created) } };
},
```

### 旧 Swig → Next.js

```html
<!-- 旧: apps/crowi-api/views/page/list.html -->
{% for page in pages %}<div>{{ page.path }}</div>{% endfor %}
```

```tsx
// 新: apps/crowi-web/src/app/(auth)/[[...slug]]/page.tsx
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

- **planner**: 旧実装の場所特定、既存の ts-rest 契約の有無を必ず確認、task ファイル作成
- **implementer**: 実装 + テスト、最後に必須チェック (type-check / test / format) を全部走らせる
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
      "apps/crowi-api/src/controllers/page.ts:554-583 (api.create)",
      "apps/crowi-api/src/routes/api/page.ts:10"
    ],
    "newImpl": [
      "apps/crowi-api/src/routes/ts-rest/page.ts (createPage)"
    ],
    "contracts": [
      "packages/api-contract/src/contracts/page.ts (createPage)",
      "packages/api-contract/src/schemas/page.ts (CreatePageRequestSchema)"
    ],
    "models": ["apps/crowi-api/src/models/page.ts"],
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
