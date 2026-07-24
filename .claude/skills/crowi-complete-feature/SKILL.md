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
9. `git diff main..HEAD --name-only | grep '^packages/e2e/'` が非空なら e2e を選択実行して
   green (`pnpm --filter @crowi/e2e e2e ...`。setup project は自動同伴)。選択ルール:
   `tests/*.spec.ts` に変更があればその spec のみ、src/ 等の共有部のみの変更なら全 spec。
   **infra (docker の mongo/redis) が落ちていて実行できない場合は fail 扱いではなく
   「blocked: e2e infra down」として signal を立てず報告**(infra を上げて再実行を促す)
10. task.json に `extraGates` (`[{ "name": "<表示名>", "cmd": "<シェルコマンド>", "cwd":
    "<worktree 相対パス。省略時は worktree root>" }]`) があれば、**各エントリを順に**
    `cwd` で `cmd` を bash 実行する。iOS 島の `xcodebuild` / `swift test` のような、標準
    ゲート (1-9) に含まれない tooling island 固有の客観ゲートを task 側から持ち込むための
    フックで、cmd はそのまま実行される(task.json は planner/人が書く信頼済みファイル
    という既存の信頼モデルのまま — 新たな面は増えない)。**1 つでも exit 0 以外なら
    fail** — 標準ゲート同様、status は変えず**どの `name` が落ちたか**を報告して終了。
    `extraGates` が無い task はこの項目を丸ごとスキップする(完全後方互換)。

#### テスト系ゲート (6・9・10) が flaky で落ちたら

テスト系ゲート — 6 (`pnpm --filter @crowi/api test`) / 9 (e2e) / 10 のテスト系
`extraGates` エントリ — が失敗したときは、即 fail と断定せず以下で flakiness を
切り分ける:

1. まず**落ちたテストファイルだけを並列度を落として単独再実行**する (jest は
   `--maxWorkers=1` で対象ファイルのみ、e2e は落ちた spec ファイル 1 本のみ)。
2. **単独再実行も fail** → flaky ではない (または深い flake)。**既存動作のまま**:
   Step 2 冒頭の規則どおり status を変えず、何が落ちたかを報告して終了。agmsg も
   特別扱いも無し (これが通常ケース)。
3. **単独再実行が pass** (並列負荷起因の flaky 疑い) → 以下 a / b を**両方**実行:
   a. **元のゲートコマンド全体をもう 1 回フル再実行**する (1 ファイルだけでなく
      suite 全体が clean かを見る)。
   b. a の結果に**かかわらず** manager へ agmsg 報告を送る (目的は gate を通す
      ことでなく manager への可視化なので、フル再実行の pass/fail どちらでも必ず
      送る)。`crowi-handoff/SKILL.md` の慣例どおり先に join 確認し、未 join /
      manager 不在 / スクリプト不在なら skip する (agmsg 未設定を理由に gate を
      block・fail させない):

      ```bash
      ~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code   # 未 join / manager 不在ならこの節は skip
      ~/.agents/skills/agmsg/scripts/send.sh crowi <own-role> manager \
        "flaky test 検知: <id> の gate で <落ちたテストファイル> が失敗。単独再実行では pass、
         フル再実行は <pass/fail>。失敗シグネチャ: <1 行要約>。根本修正はこのセッションでは
         行いません — CLAUDE.md の flake/CI-infra diagnosis rule に従って Codex sol/Fable への
         委譲をお願いします。"
      ```
   c. a のフル再実行が **green** → このゲート項目は pass 扱いとし、Step 2 の次の
      項目へ進む (flaky 失敗はこの run を block しない — ただし b の agmsg は
      送信済みなので、握り潰しにはならない)。
   d. a のフル再実行が**まだ fail** → Step 2 の既存規則どおり本物の失敗として扱う
      (status を変えず報告して終了)。単一ファイルレベルで flaky でも、suite
      レベルで失敗が持続するならそちらが優先。
4. **根本修正をこのセッションで推測・着手することは絶対にしない** (「一度確認して
   後で pass した」flaky でも同じ)。root-cause 対応は常に agmsg を受けた側に委ねる
   (CLAUDE.md「Flaky test / CI-infra root cause」規則。manager 側の反応手順は
   `crowi-role-manager/SKILL.md` 参照)。

### Step 3: signal を立てる (全 green のときだけ)

ゲートが落ちていれば **ファイルは一切触らず** Step 4 で報告して終わる
(synthesize もしない — ready でない signal は作らない)。全 green のときのみ、
task ファイルの有無で 3a / 3b に分岐する。いずれも `.feature-state/tasks/*.json` への
Write/Edit は PreToolUse hook が拒否するため、**`.claude/scripts/task-state.sh` 経由でのみ**
書く(script が tmp+不変条件検証+atomic rename+`.bak` を担保する。詳細は
`task-state.sh --help`)。

`readyForMerge` ブロックは両分岐で共通:

```json
"readyForMerge": {
  "at": "<ISO8601>",
  "branch": "<git rev-parse --abbrev-ref HEAD>",
  "headSha": "<git rev-parse HEAD>",
  "checks": {
    "typeCheck": true, "test": true, "lint": true, "openapi": true, "e2e": true,
    "extra": { "<name>": true }
  },
  "notes": "<走らせたゲートの結果サマリ。N/A だったもの (例: 契約未変更で openapi N/A) も明記>"
}
```

`checks.extra` は task.json に `extraGates` があるときだけ付ける(既存 checks フィールドの
拡張。`extraGates` が無い task では従来どおり `extra` キー自体を書かない)。

#### Step 3a: 既存 task を更新

`status` を `READY_TO_INTEGRATE` にし、`readyForMerge` を上書きする。
**他のフィールドは保持** (name / context / acceptanceCriteria / commitInfo /
history 等 — `task-state.sh` の各サブコマンドは対象フィールドしか触らないので
自然に保持される)。`history` には `READY_TO_INTEGRATE` エントリを 1 つ append する。

```bash
# readyForMerge は一時ファイルに書いてから --value-file で渡す
bash .claude/scripts/task-state.sh task set-field {id} readyForMerge --value-file <scratch-path>
bash .claude/scripts/task-state.sh task set-status {id} READY_TO_INTEGRATE
bash .claude/scripts/task-state.sh task append-history {id} \
  '{"at":"<ISO8601>","event":"READY_TO_INTEGRATE","by":"crowi-complete-feature","note":"All objective gates green. Signal set for crowi-orchestrate integrate watcher."}'
```

#### Step 3b: task を synthesize (ファイルが無い場合)

spec を経由していないので、内容は **git から起こす**。最低限 orchestrate の裏取り
(status / worktree 特定 / `readyForMerge.headSha` 照合) が通る形にしつつ、後で人が
読めるよう provenance を残す:

- `name` — `git log main..HEAD` の主コミット subject から人間可読な 1 行。
- `commitInfo.commits` — `git log main..HEAD --oneline` の全行。
- `context` / `acceptanceCriteria` — コミット本文から起こせる範囲で要約 (spec が
  無いので簡潔で可)。起こせなければ `context` のみで `acceptanceCriteria` は省略可。
- `origin` — synthesize した事実を必ず明記 (下記テンプレの固定文)。
- `openQuestions` — 無ければ空配列 (`task-state.sh task create` は
  `id`/`name`/`status`/`scope`/`context`/`openQuestions`/`history`/`phases` の存在を必須と
  する)。
- `phases` — synthesize した task は phase 分割が無いので `[]` を渡す
  (`task-state.sh` は空配列を single-phase task の正当な表現として受け付ける)。

以下の JSON を Write で **scratch パス**(`.feature-state/tasks/` 直下は不可 — hook が
拒否する)に書き出し、`bash .claude/scripts/task-state.sh task create {id} <scratch-path>`
で配置する:

```json
{
  "id": "<id>",
  "name": "<主コミット subject から>",
  "status": "READY_TO_INTEGRATE",
  "scope": "<触った領域。例 'api (packaging)'>",
  "origin": "Manual fix branch (<branch>), not created via the spec -> task feature workflow. This task record was synthesized by crowi-complete-feature solely to carry the READY_TO_INTEGRATE signal for crowi-orchestrate.",
  "context": "<何をなぜ直したか。コミット本文から>",
  "acceptanceCriteria": ["<コミット本文から起こせれば>"],
  "openQuestions": [],
  "phases": [],
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
