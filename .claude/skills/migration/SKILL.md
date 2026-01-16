---
name: crowi-migration
description: |
  Crowi 2.0 移行ワークフロー。Express/Swig から Next.js + ts-rest への移行時に自動適用。
  キーワード: migrate, 移行, Express, Swig, legacy, 旧実装
globs:
  - "lib/routes/**"
  - "lib/views/**"
  - "client/components/**"
---

# Crowi 2.0 Migration Skill

## アーキテクチャ

```
crowi/
├── apps/
│   ├── crowi-api/          # Fastify + ts-rest (port 3300)
│   └── crowi-web/          # Next.js 16 (port 3301)
├── packages/
│   ├── api-contract/       # ts-rest 契約定義
│   └── shared/             # 共有型
└── lib/                    # 旧実装（参照元）
    ├── routes/             # Express ルート
    ├── views/              # Swig テンプレート
    └── models/             # Mongoose モデル
```

## 移行パターン

### Express Route → Fastify + ts-rest

```typescript
// Before: lib/routes/page.js
router.get('/pages', async (req, res) => {
  const pages = await Page.find();
  res.render('page/list', { pages });
});

// After: packages/api-contract/src/page.ts
export const pageContract = c.router({
  listPages: {
    method: 'GET',
    path: '/pages',
    responses: { 200: z.object({ pages: z.array(PageSchema) }) },
  },
});

// After: apps/crowi-api/src/routes/page.ts
listPages: async () => {
  const pages = await Page.find();
  return { status: 200, body: { pages } };
},
```

### Swig Template → Next.js Page

```typescript
// Before: lib/views/page/list.html
{% for page in pages %}
  <div>{{ page.path }}</div>
{% endfor %}

// After: apps/crowi-web/app/(main)/pages/page.tsx
'use client';
export default function PagesPage() {
  const { data } = useQuery(['pages'], () => client.page.listPages());
  return data?.body.pages.map(page => <div key={page._id}>{page.path}</div>);
}
```

## サブエージェント

| Agent | 役割 | ツール |
|-------|------|--------|
| migration-planner | 計画立案 | Read, Grep, Glob |
| migration-implementer | 実装 | Read, Write, Edit, Bash |
| migration-reviewer | レビュー | Read, Grep, Bash |
| migration-committer | コミット・PR | Read, Bash |

## ワークフロー

```
/migrate {task-name}

planner → implementer → reviewer ─┬→ committer
                          ↑       │
                          └───────┘ (NEEDS_WORK)
```

## タスク管理

- キュー: `.claude/migration-state/queue.json`
- タスク: `.claude/migration-state/tasks/{task-id}.json`
- ステータス: `PLANNED` → `REVIEW` → `APPROVED` → `COMMITTED`

## 技術スタック

- **API**: Fastify v5, ts-rest, MongoDB/Mongoose, JWT
- **Web**: Next.js 16, React 19, Tailwind v4, shadcn/ui
- **共通**: TypeScript 5.x strict, pnpm, Turborepo

## Crowi テーマ

```css
--crowi-primary: #43676b;
--crowi-header: #263a3c;
--crowi-sidebar: #f8f9fa;
```
