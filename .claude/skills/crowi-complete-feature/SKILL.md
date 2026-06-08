---
name: crowi-complete-feature
description: |
  worktree での実装 + QA + 修正が全部終わったと自分で判断したときに worktree
  セッションで起動する。客観ゲート (clean / commit あり / type-check / test /
  lint / openapi) を走らせ、全部 green のときだけ tasks/{id}.json を
  READY_TO_INTEGRATE にする。これが main 側 crowi-orchestrate (integrate
  watcher) が拾う "ready for merge" signal になる。
  キーワード: complete, done, 完了, ready for merge, ready, 取り込み準備
---

# Crowi Complete Feature (worktree を ready for merge にする)

並行 worktree で 1 機能の実装 / QA / 修正が **全部終わったと自分で判断した** とき、
その worktree セッションで起動する skill。

役割は「**完了宣言の signal を立てる**」こと。ただし宣言を鵜呑みにしないため、
客観ゲートを走らせ、**全部 green のときだけ** `tasks/{id}.json` を
`READY_TO_INTEGRATE` にする。落ちていれば status は変えず、何が落ちたか報告する。

この signal を、main セッションで回っている `crowi-orchestrate` (integrate
watcher) が次の tick で拾い、裏取りした上で `integrate-worktree` を起動する。

## 起動例

```
/crowi-complete-feature              # 現在の worktree の task を ready 判定
/crowi-complete-feature <id>         # task id を明示
```

## 前提

- **worktree (= main 以外のブランチ) で実行する。** main では実行しない。
- 対応する `.feature-state/tasks/{id}.json` が存在する。
  - `id` は worktree 名 / ブランチ名と揃える運用 (例 `gw start feature-foo`)。
- `tasks/` は gw hook で main store に symlink 共有されているので、ここで立てた
  signal は main セッションから見える。`queue.json` は per-worktree。

## ワークフロー

### Step 1: コンテキスト確認

- `git rev-parse --abbrev-ref HEAD` が `main` でないことを確認 (main なら中止)。
- task id を解決: 引数 > worktree ディレクトリ名 > `queue.json` の `currentTask`。
- `.feature-state/tasks/{id}.json` を読む (なければ中止して報告)。

### Step 2: ゲート (全部 green でなければ ready にしない)

順に実行し、**1 つでも失敗したら status を変えず**、何が落ちたかを報告して終了:

1. 作業ツリー clean (`git status --porcelain` が空)。dirty なら
   「commit してから再実行」と促して中止 (勝手に commit はしない)。
2. `git log main..HEAD` が非空 (= 取り込む commit がある)。
3. 契約を触っていれば `pnpm --filter @crowi/api-contract build`
4. `pnpm --filter @crowi/api type-check`
5. `pnpm --filter @crowi/web type-check`
6. `pnpm --filter @crowi/api test`
7. `pnpm lint` (errors=0 必須、warnings は許容)
8. 契約を触っていれば `pnpm check:openapi` (drift なし)

### Step 3: signal を立てる

全 green のときだけ `tasks/{id}.json` を更新 (torn write を避けるため tmp+rename で
atomic):

```json
{
  "status": "READY_TO_INTEGRATE",
  "readyForMerge": {
    "at": "<ISO8601>",
    "branch": "<branch>",
    "headSha": "<git rev-parse HEAD>",
    "checks": { "typeCheck": true, "test": true, "lint": true, "openapi": true }
  }
}
```

他のフィールドは保持する (status と readyForMerge のみ更新)。

### Step 4: 報告

```
<id> は ready for merge です (branch <b> @ <sha>、全ゲート green)。
main セッションの crowi-orchestrate が次の tick で裏取りして integrate-worktree を起動します。
```

## やらないこと

- **main への merge** (それは `integrate-worktree` / `crowi-orchestrate` の役目)。
- **push** (常にユーザー指示待ち)。
- ゲートが落ちている状態での status 変更 (絶対にしない — これが signal の信頼性)。
- dirty な作業ツリーの自動 commit。
