---
name: crowi-complete-feature
description: |
  worktree での実装 + QA + 修正が全部終わったと自分で判断したときに worktree
  セッションで起動する。客観ゲート (clean / commit あり / type-check / test /
  lint / openapi) を走らせ、全部 green のときだけ tasks/{id}.json を
  READY_TO_INTEGRATE にする (spec を切らず gw start から直接 fix した等で task
  ファイルが無ければ synthesize して作る)。これが main 側 crowi-orchestrate
  (integrate watcher) が拾う "ready for merge" signal になる。
  キーワード: complete, done, 完了, ready for merge, ready, 取り込み準備
---

# Crowi Complete Feature (worktree を ready for merge にする)

並行 worktree で 1 機能の実装 / QA / 修正が **全部終わったと自分で判断した** とき、
その worktree セッションで起動する skill。

役割は「**完了宣言の signal を立てる**」こと。ただし宣言を鵜呑みにしないため、
客観ゲートを走らせ、**全部 green のときだけ** `tasks/{id}.json` を
`READY_TO_INTEGRATE` にする (task ファイルが無ければ synthesize して作る)。
落ちていれば signal は立てず、何が落ちたか報告する。

この signal を、main セッションで回っている `crowi-orchestrate` (integrate
watcher) が次の tick で拾い、裏取りした上で `integrate-worktree` を起動する。

## 起動例

```
/crowi-complete-feature              # 現在の worktree の task を ready 判定
/crowi-complete-feature <id>         # task id を明示
```

## 前提

- **worktree (= main 以外のブランチ) で実行する。** main では実行しない。
- `id` は worktree 名 / ブランチ名と揃える運用 (例 `gw start feature-foo`)。
- 対応する `.feature-state/tasks/{id}.json` は **あってもなくてもよい**:
  - **ある** — spec → planner 経由で作った機能。それを更新する (Step 3a)。
  - **無い** — spec を切らず `gw start` → 調査依頼から直接 fix した等。この skill が
    **全ゲート green のときに synthesize** して signal を立てる (Step 3b)。
    task ファイルが無いことを理由に中止しない (それだと orchestrate が拾えず作業が
    宙に浮く)。
- `tasks/` は gw hook で main store に symlink 共有されているので、ここで立てた
  signal は main セッションから見える。`queue.json` は per-worktree。

## ワークフロー

### Step 1: コンテキスト確認

- `git rev-parse --abbrev-ref HEAD` が `main` でないことを確認 (main なら中止)。
- task id を解決: 引数 > worktree ディレクトリ名 (`basename $(git rev-parse
  --show-toplevel)` の先頭 `crowi-` を除去) > `queue.json` の `currentTask`。
  - id は **orchestrate が worktree を特定する key** (worktree パスが `id` を含む)
    なので、worktree ディレクトリ名と揃うように解決すること。
- `.feature-state/tasks/{id}.json` を読む。
  - **ある** → 既存 task。Step 3a で `status` / `readyForMerge` を更新する。
  - **無い** → spec を経由しない直 fix。**中止しない。** Step 3b で synthesize する。
    flag を立てて orchestrate が拾えるようにするのがこの skill の役目。

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
9. `git diff main..HEAD --name-only | grep '^packages/e2e/'` が非空なら、変更された
   `tests/*.spec.ts` を選択実行して green (`pnpm --filter @crowi/e2e e2e tests/<file>.spec.ts`。
   setup project は自動同伴)。**infra (docker の mongo/redis) が落ちていて実行できない
   場合は fail 扱いではなく「blocked: e2e infra down」として signal を立てず報告**
   (infra を上げて再実行を促す)

### Step 3: signal を立てる (全 green のときだけ)

ゲートが落ちていれば **ファイルは一切触らず** Step 4 で報告して終わる
(synthesize もしない — ready でない signal は作らない)。全 green のときのみ、
task ファイルの有無で 3a / 3b に分岐する。いずれも torn write を避けるため
**tmp+rename で atomic** に書く。

`readyForMerge` ブロックは両分岐で共通:

```json
"readyForMerge": {
  "at": "<ISO8601>",
  "branch": "<git rev-parse --abbrev-ref HEAD>",
  "headSha": "<git rev-parse HEAD>",
  "checks": { "typeCheck": true, "test": true, "lint": true, "openapi": true, "e2e": true },
  "notes": "<走らせたゲートの結果サマリ。N/A だったもの (例: 契約未変更で openapi N/A) も明記>"
}
```

#### Step 3a: 既存 task を更新

`status` を `READY_TO_INTEGRATE` にし、`readyForMerge` を上書きする。
**他のフィールドは保持** (name / context / acceptanceCriteria / commitInfo /
history 等)。`history` には `READY_TO_INTEGRATE` エントリを 1 つ append する。

#### Step 3b: task を synthesize (ファイルが無い場合)

spec を経由していないので、内容は **git から起こす**。最低限 orchestrate の裏取り
(status / worktree 特定 / `readyForMerge.headSha` 照合) が通る形にしつつ、後で人が
読めるよう provenance を残す:

- `name` — `git log main..HEAD` の主コミット subject から人間可読な 1 行。
- `commitInfo.commits` — `git log main..HEAD --oneline` の全行。
- `context` / `acceptanceCriteria` — コミット本文から起こせる範囲で要約 (spec が
  無いので簡潔で可)。起こせなければ `context` のみで `acceptanceCriteria` は省略可。
- `origin` — synthesize した事実を必ず明記 (下記テンプレの固定文)。

```json
{
  "id": "<id>",
  "name": "<主コミット subject から>",
  "status": "READY_TO_INTEGRATE",
  "scope": "<触った領域。例 'api (packaging)'>",
  "origin": "Manual fix branch (<branch>), not created via the spec -> task feature workflow. This task record was synthesized by crowi-complete-feature solely to carry the READY_TO_INTEGRATE signal for crowi-orchestrate.",
  "context": "<何をなぜ直したか。コミット本文から>",
  "acceptanceCriteria": ["<コミット本文から起こせれば>"],
  "commitInfo": { "branch": "<branch>", "commits": ["<sha> <subject>", "..."] },
  "readyForMerge": { "...共通ブロック..." },
  "history": [
    { "event": "COMMITTED", "by": "crowi-complete-feature", "note": "Task record synthesized for a manual fix branch (no spec). Fix already committed." },
    { "at": "<ISO8601>", "event": "READY_TO_INTEGRATE", "by": "crowi-complete-feature", "note": "All objective gates green. Signal set for crowi-orchestrate integrate watcher." }
  ]
}
```

synthesize した task も既存 task と同じ扱いで orchestrate に拾われる
(integrate-worktree が裏取り → merge する)。

### Step 4: 報告

```
<id> は ready for merge です (branch <b> @ <sha>、全ゲート green)。
[synthesize した場合] spec 無しの直 fix だったので task を新規 synthesize しました。
main セッションの crowi-orchestrate が次の tick で裏取りして integrate-worktree を起動します。
```

## やらないこと

- **main への merge** (それは `integrate-worktree` / `crowi-orchestrate` の役目)。
- **push** (常にユーザー指示待ち)。
- ゲートが落ちている状態での status 変更 / task の synthesize (絶対にしない —
  これが signal の信頼性。ready でない signal は作らない)。
- dirty な作業ツリーの自動 commit。
- task ファイルが無いことを理由にした中止 (= 旧仕様。今は Step 3b で synthesize する)。
