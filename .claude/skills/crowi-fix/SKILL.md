---
name: crowi-fix
description: |
  バグ報告・小修正のための軽量ワークフロー。spec 不要。再現(失敗するテスト)を先に作り、
  systematic-debugging で根本原因を特定してから直す。ゲート(type-check / test / lint)→
  codex 1 パスレビュー → commit。設計判断が要る規模なら crowi-design / crowi-feature へ誘導。
  キーワード: fix, バグ, 修正, bug, 不具合, repro, 直して, 壊れてる
---

# Crowi Fix (repro-first の軽量バグ修正)

「壊れているものを直す」ための最短経路。crowi-feature の planner/レビューループは
重すぎ、アドホックだと再現なし・根本原因なしの推測修正が混ざる — その中間を定型化する。

## crowi-feature との使い分け

| 条件 | 使うもの |
|---|---|
| 挙動が壊れている・期待とのズレが明確・設計判断不要 | **crowi-fix** |
| 新しい挙動を足す / 契約・スキーマ変更を伴う / 設計判断あり | crowi-feature(必要なら crowi-design から) |
| 修正方針に複数案があり trade-off 判断が要る | いったん止まってユーザーに確認(勝手に選ばない) |

途中で「設計判断が要る」と気づいたら、進めずにその時点で報告して切り替える。

## ワークフロー

### Step 1: 再現(repro-first)

- **修正より先に、失敗するテストを書く**(api は jest + supertest + mongodb-memory-server)。
  「バグが直るとこのテストが green になる」が完了の定義。
- テストで再現しづらい UI バグ: 再現手順を記録し、クリティカルフロー
  (feature-planner.md の表)に該当し小さく書けるなら `packages/e2e/tests/` に足す(無理はしない)。
- **再現できないバグは直さない** — 推測修正は禁止。再現条件をユーザーに確認して止まる。

### Step 2: 根本原因の特定(systematic-debugging)

症状 → 仮説 → 検証を繰り返し、**根本原因を file:line で特定してから**修正に入る。
対症療法(症状を隠すだけの分岐)を書かない。

### Step 3: 修正 + ゲート

- 最小 diff。関係ないリファクタを混ぜない。
- ゲート: `pnpm --filter @crowi/api type-check`(web を触ったら +web)/
  該当テスト(Step 1 のテスト含む)/ `pnpm lint`(errors=0)/
  契約を触ったら `pnpm --filter @crowi/api-contract build` + `pnpm check:openapi`。

### Step 4: codex 1 パスレビュー(fix or drop)

```bash
mkdir -p .reviews/codex-runs/fix-<topic>
# prompt: 「git status --porcelain + git diff HEAD で修正を取得し(untracked は直接読む)、
#          退行・境界・並行の観点で敵対レビューせよ」+ FINDINGS schema (crowi-review と同形)
bash .claude/scripts/codex-run.sh --sandbox read-only \
  --prompt-file .reviews/codex-runs/fix-<topic>/prompt.md \
  --schema-file .reviews/codex-runs/fix-<topic>/schema.json \
  --out .reviews/codex-runs/fix-<topic>/out.json --label fix-<topic>
```

- 重い 3 lens は使わない(1 パスのみ)。
- **findings は「直すか捨てる」の二択**: 自分でコードに当てて裏取りし、正しければ
  その場で直してゲート再走。誤り・過大なら捨てる(報告に 1 行)。
  **TODO 等への退避は禁止**(fix or drop — 全 skill 共通方針)。
- exit 2(codex 不可)なら skip して報告(レビュー無しで止めない)。

### Step 5: commit

- `fix(<scope>): <what>` + 本文に root cause を 1-3 行。テストは同 commit か
  `test(<scope>)` 分割(diff サイズで判断)。
- **ユーザー可視のバグ修正なら changeset(patch)を追加**。内部のみなら不要。
- main 直でも worktree でも可。worktree の場合、完了後は `/crowi-complete-feature`
  (task ファイル無し → synthesize が signal を立てる — 既存互換)。**push しない**。

## 鉄則

- 再現なしに直さない / 根本原因なしに直さない
- レビュー指摘は **fix or drop**(TODO・backlog へ退避しない)
- 設計判断が要ると気づいたら勝手に進めず crowi-design / ユーザーへ
- push はユーザー指示待ち
