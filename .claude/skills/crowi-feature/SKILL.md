---
name: crowi-feature
description: |
  Crowi 2.0 の新機能開発ワークフロー。設計合意 (会話で詰めた spec) を起点に、
  spec → planner → implementer → simplify → reviewer → committer まで自動で進める。
  キーワード: feature, 新機能, 開発, build, 設計, spec
globs:
  - "apps/crowi-api/src/routes/ts-rest/**"
  - "apps/crowi-web/src/app/**"
  - "packages/api-contract/src/**"
---

# Crowi 2.0 Feature Skill

新規機能をゼロから追加するためのワークフロー。
旧実装互換が前提の `crowi-migration` と並列の skill。**設計を会話で詰めた後** に
起動して自動進行させるのが想定パターン。

## 想定ユースケース

- 新規 API エンドポイントの追加 (旧実装が無い)
- 新しい admin 画面 / ユーザー画面の追加
- 既存機能への大きめの拡張 (旧実装と挙動が変わる)
- ライブラリ・ツール導入を伴う機能

旧 Express/Swig コードからの移植は `crowi-migration` を使う。

## ワークフロー全体像

```
   ↓ 会話で設計を詰める (壁打ち)
   ↓ ユーザー: 「これで実装!」
   ↓
/feature {name}
   ↓
[spec phase]
   spec.md があれば: そのまま使う
   なければ: 直近会話を要約して .feature-state/specs/{name}.md を生成 → ユーザー確認
   ↓
[scope 判定]
   spec.md の `scope:` (trivial|small|medium|large) で planner を skip するか決める
   trivial / small ≤ minScopeSize: planner skip → implementer 直行
   medium / large >  minScopeSize: planner 起動
   ↓
planner ──→ implementer ──→ simplify ──→ reviewer ─┬→ committer
                ↑                          ↑       │
                └─────── NEEDS_WORK ───────┴───────┘
```

各 phase の責務:

- **planner**: spec を読み、コードベースを grep して再利用候補 (hooks / components / utils / 既存契約) を context に充填、AC を spec から起こす
- **implementer**: 実装 + テスト、必須チェック (type-check / test / lint / format) を全部走らせる、commitPlan を埋める
- **simplify**: `simplify` skill を呼び、reuse / quality / efficiency を整える
- **reviewer**: AC 達成 / 契約整合 / セキュリティ / トランザクション境界を確認
- **committer**: task.commitPlan に従って **複数 commit** を作る (feat 本体 / test / docs を分割)

## state 管理

ディレクトリ: **`.feature-state/` (リポジトリ root)** ※ `.claude/feature-state/` ではない
gitignore 済み (`.gitkeep` のみ tracked)。

```
.feature-state/
├── .gitkeep
├── queue.json              # currentTask + global config
├── specs/
│   └── {id}.md            # 会話を要約した設計仕様 (人間レビュー対象)
└── tasks/
    └── {id}.json          # planner が埋めた context + AC + commitPlan
```

### queue.json スキーマ

```json
{
  "currentTask": "feature-attachment-thumbnail",
  "config": {
    "commitStrategy": "main-direct",
    "maxReviewAttempts": 3,
    "runSimplify": true,
    "minScopeSize": "small"
  },
  "lastUpdated": "2026-05-09T..."
}
```

`config.minScopeSize`: `trivial | small | medium | large`
spec の `scope:` がこの閾値より大きい (`>`) ときだけ planner が起動する。
デフォルト `small` (= medium 以上で planner、small / trivial は skip)。
順序は `trivial < small < medium < large`。

### spec.md スキーマ

```markdown
---
id: feature-attachment-thumbnail
name: 添付画像のサムネイル生成
scope: medium
---

## 背景 / why
...

## やること (ユーザー視点)
...

## やらないこと (out of scope)
...

## 設計の主な判断
- どこに置くか (API / Web / 共通)
- 依存ライブラリの追加可否
- DB スキーマ変更の有無
- パフォーマンス / セキュリティ上の制約

## 受け入れ基準 (acceptance criteria)
- [ ] ...
- [ ] ...

## 未確定事項 (open questions)
- ...
```

`scope` の目安:
- **trivial**: 1 ファイル / 50 行未満 / 既存 helper 流用 / テスト不要レベル
- **small**: 1〜2 ファイル + テスト / 既存契約を拡張するだけ
- **medium**: 新契約 + API + UI / 複数 commit / 数百行
- **large**: 新モデル or 新 schema or 外部サービス連携。**planner で task 分割を強く検討**

### task ファイルスキーマ (`tasks/{id}.json`)

```json
{
  "id": "feature-attachment-thumbnail",
  "name": "添付画像のサムネイル生成",
  "status": "PLANNED",
  "scope": "medium",
  "context": {
    "specPath": ".feature-state/specs/feature-attachment-thumbnail.md",
    "reuseTargets": [
      "apps/crowi-api/src/util/fileUploader.ts (driver 抽象を再利用)",
      "apps/crowi-web/src/components/page-view/AttachmentList.tsx (一覧 UI に組み込み)"
    ],
    "newFiles": [
      "apps/crowi-api/src/util/thumbnail.ts (sharp ラッパー)",
      "packages/api-contract/src/contracts/attachment-thumbnail.ts (新契約)"
    ],
    "models": ["apps/crowi-api/src/models/attachment.ts (thumbnail フィールド追加)"],
    "newDeps": ["sharp (画像処理)"],
    "architecturalNotes": "Storage driver 経由で生成・保存。同期処理 (アップロード時にブロック)。"
  },
  "acceptanceCriteria": [
    "画像添付時に 320x320 サムネが生成され S3/local 両方で取得できる",
    "非画像 (PDF 等) はサムネ生成をスキップする",
    "失敗してもアップロード自体は成功する"
  ],
  "openQuestions": ["sharp のメモリ上限"],
  "commitPlan": [
    {
      "type": "feat",
      "scope": "api",
      "title": "implement attachment thumbnail generation",
      "files": ["apps/crowi-api/src/util/thumbnail.ts", "..."]
    },
    {
      "type": "test",
      "scope": "api",
      "title": "cover thumbnail generation edge cases",
      "files": ["apps/crowi-api/src/util/thumbnail.test.ts"]
    },
    {
      "type": "docs",
      "scope": "todo",
      "title": "mark attachment thumbnail done",
      "files": ["TODO.md"]
    }
  ],
  "history": [
    {"phase": "planner", "at": "ISO8601", "summary": "計画完了"}
  ]
}
```

## 起動フロー (skill 内手順)

`/feature {name}` が呼ばれたら以下を実行:

### 1. spec の準備

```
1.1. .feature-state/specs/{name}.md の有無を確認
1.2. あれば: そのまま使う (人間レビュー済みとみなして次へ)
1.3. なければ:
     - 直近会話を読み、spec の各セクションを埋めて .feature-state/specs/{name}.md を書き出す
     - scope は会話内容と編集規模見込みから自動判定
     - 「以下の spec で進めますか?」とユーザーに提示し、承認を待つ
     - ユーザーから修正指示があれば反映、再提示
1.4. spec.md の scope を読み取る
```

### 2. scope 判定 → planner skip 判定

```
2.1. queue.json の config.minScopeSize を読む (なければ "small" デフォルト)
2.2. spec.md の scope と比較
     scope ≤ minScopeSize: planner skip
     scope >  minScopeSize: planner 起動
2.3. planner skip の場合は、最小限の task.json を skill 内で生成
     (specPath / acceptanceCriteria / scope を spec から引き写し、
      status は PLANNED で書き出す。implementer はこの初期状態を期待する)
```

### 3. agent チェーン

```
3.1. planner (起動した場合) が context を充填して REVIEW pending 状態に
3.2. implementer: task.json を読んで実装、commitPlan を埋め、必須チェック後に REVIEW
3.3. simplify (config.runSimplify が true なら): 直近 diff を整理
3.4. reviewer: APPROVED または NEEDS_WORK
3.5. NEEDS_WORK なら implementer に戻す (最大 maxReviewAttempts 回)
3.6. APPROVED → committer が commitPlan に従って複数 commit
```

### 4. 完了

`task.status = COMMITTED`、`queue.currentTask = null`。
push / PR 作成は **明示指示があるまで行わない**。

## ステータス遷移

```
PLANNED → IN_PROGRESS → REVIEW → (APPROVED → COMMITTED) | NEEDS_WORK → IN_PROGRESS → ...
```

## サブコマンド (個別 phase 起動)

```
/feature {name}                # 全自動 (会話前提)
/feature plan {name}           # planner だけ
/feature implement {id}        # implementer だけ (NEEDS_WORK / IN_PROGRESS のとき)
/feature review {id}           # reviewer だけ (REVIEW のとき)
/feature commit {id}           # committer だけ (APPROVED のとき)
```

migration skill と同じパターン。

## migration skill との違い (まとめ)

| 観点 | migration | feature |
|---|---|---|
| 起点 | 旧 Express/Swig コード | 会話で詰めた spec.md |
| context 充填 | 旧実装場所を grep | 再利用候補を grep + spec を引き写し |
| 互換性制約 | 旧実装と挙動一致が最優先 | なし (新規) |
| reviewer 観点 | 旧実装互換 | AC 達成 + 設計合意整合 |
| commit 単位 | 1 タスク = 1 commit | 1 タスク = N commit (commitPlan による分割) |

## 重要な前提

- **state ディレクトリは `.feature-state/` (root)** ※ `.claude/feature-state/` ではない
- **main 直コミット運用** がデフォルト (queue.json `commitStrategy: main-direct`)
- ts-rest ルートは `authenticatedRouter` 配下なら `jwtAuth` が自動適用、CSRF 不要
- 新契約は `packages/api-contract/src/contracts/{feature}.ts` に追加、build 必須
  (`pnpm --filter @crowi/api-contract build`)
- 新 UI は `apps/crowi-web/src/app/(auth or admin)/...` 配下、shadcn/ui + tanstack/react-query

## Crowi テーマ

```css
--crowi-primary: #43676b;
--crowi-header: #263a3c;
--crowi-sidebar: #f8f9fa;
```
