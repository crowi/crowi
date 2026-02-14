---
name: migrate
description: Crowi 移行タスクのワークフローを実行
---

# Crowi Migration Workflow

このコマンドは Crowi 2.0 移行タスクのワークフローを実行します。

## 使い方

```bash
# 新しい機能の移行を開始
/migrate page-list

# 特定のステップから再開
/migrate page-list --from=review

# タスク一覧を表示
/migrate --list

# タスクの状態を確認
/migrate page-list --status
```

## ワークフロー

```
┌─────────────────┐
│  migration-     │
│  planner        │──→ タスクを分析・計画
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  migration-     │
│  implementer    │◀─┐ 実装を行う
└────────┬────────┘  │
         │           │
         ▼           │ NEEDS_WORK
┌─────────────────┐  │ (最大3回)
│  migration-     │──┘
│  reviewer       │──→ レビュー
└────────┬────────┘
         │ APPROVED
         ▼
┌─────────────────┐
│  migration-     │
│  committer      │──→ コミット・PR作成
└─────────────────┘
```

## 実行手順

### Step 1: 計画 (Planning)

```
Use the migration-planner subagent to analyze and plan the migration for: {task-name}
```

プランナーが以下を行います：
- 旧実装のコードを分析
- 移行に必要な作業を特定
- タスク定義を `.migration-state/tasks/{task-id}.json` に保存
- キューを更新

### Step 2: 実装 (Implementation)

```
Use the migration-implementer subagent to implement the task: {task-id}
```

実装者が以下を行います：
- ts-rest 契約を定義
- API エンドポイントを実装
- フロントエンドを実装
- ステータスを `REVIEW` に更新

### Step 3: レビュー (Review)

```
Use the migration-reviewer subagent to review the implementation for: {task-id}
```

レビュアーが以下を行います：
- 型チェック・リント実行
- コード品質を確認
- 機能要件を検証

**判定結果に応じた分岐：**

- `APPROVED` → Step 4 へ
- `NEEDS_WORK` → Step 2 へ戻る（最大3回）
- 3回失敗 → 人間にエスカレート

### Step 4: コミット (Commit)

```
Use the migration-committer subagent to commit and create PR for: {task-id}
```

コミッターが以下を行います：
- 適切なブランチを作成
- Conventional Commits 形式でコミット
- GitHub PR を作成
- ステータスを `COMMITTED` に更新

## 状態管理ファイル

### queue.json

```json
{
  "tasks": [
    {
      "id": "migrate-page-list",
      "status": "PLANNED",
      "priority": 1
    }
  ],
  "currentTask": null,
  "lastUpdated": "2025-01-15T00:00:00Z"
}
```

### tasks/{task-id}.json

```json
{
  "id": "migrate-page-list",
  "name": "ページ一覧表示の移行",
  "status": "PLANNED",
  "reviewAttempts": 0,
  "history": [
    {
      "action": "created",
      "at": "2025-01-15T00:00:00Z",
      "by": "migration-planner"
    }
  ]
}
```

## エラーハンドリング

### 実装で詰まった場合

```
実装が難しい場合は、タスクを分割してください：

1. 現在のタスクを BLOCKED に
2. より小さなサブタスクを作成
3. サブタスクから順に実行
```

### レビューで3回失敗

```
⚠️ 人間のレビューが必要です

タスク: {task-id}
失敗理由: {reviewFeedback の要約}

以下を確認してください：
1. タスクの要件が適切か
2. 技術的に実現可能か
3. 手動での介入が必要か
```

## Tips

### 並列実行

複数の独立したタスクがある場合、別々のセッションで並列実行可能：

```bash
# Terminal 1
/migrate page-list

# Terminal 2
/migrate user-settings
```

### 部分的な実行

特定のステップだけ実行したい場合：

```bash
# 計画だけ
Use the migration-planner subagent to analyze: page-list

# レビューだけ
Use the migration-reviewer subagent to review: migrate-page-list
```

### 状態のリセット

タスクを最初からやり直す場合：

```bash
# タスクファイルを削除
rm .migration-state/tasks/migrate-page-list.json

# queue.json から該当タスクを削除
# その後、/migrate page-list を再実行
```
