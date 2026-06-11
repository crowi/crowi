---
name: crowi-orchestrate
description: |
  main セッションで /loop から 1 tick ごとに呼ぶ前提のオーケストレーション skill。
  (A) ready for merge になった worktree を裏取りして integrate-worktree で取り込む、
  (B) specs/ を groom して着手 ready / 不足要素 / 削除候補を報告する、
  (C) main に直接積まれた作業が意味のある塊になったら code-review をかける、の 3 系統を
  実行する。push しない・spec を自動削除しない・dirty な main に勝手に commit しない・
  詰まったら ping して待つ。
  キーワード: orchestrate, loop, watcher, integrate, groom, spec 整理, code-review
---

# Crowi Orchestrate (per-tick: ready worktree 取り込み + spec groom + main review)

main セッションで `/loop /crowi-orchestrate` として **1 tick ごとに呼ばれる** 前提の
skill。単発 (`/crowi-orchestrate`) でも動く。3 系統を順に実行する。

**鉄則 (毎 tick 守る):**
- **push しない** (常にユーザー指示待ち)。
- **spec を自動削除しない** (削除は提案のみ、user 承認を待つ)。
- **main が dirty なら integrate しない / dirty な main に勝手に commit しない**
  (skip して報告)。
- **不可逆 / 判断系で詰まったら強行せず ping して待つ**。

## A. integrate watcher (行動系)

ready for merge な worktree を取り込む。

1. `.feature-state/tasks/*.json` を読み、`status === "READY_TO_INTEGRATE"` の
   task を探す。なければ A は skip。
2. 各 ready task について、`git worktree list` から worktree を特定
   (worktree 名 = task id の運用)。worktree が見つからなければ報告して skip。
3. **裏取り (signal を鵜呑みにしない):**
   - worktree が clean (`git -C <wt> status --porcelain` 空)
   - `git log main..<branch>` が非空
   - `tasks/{id}.json` の `readyForMerge.headSha` が現在の branch HEAD と一致
     (古い signal でない。ズレていたら「signal が stale」と報告して skip)
4. main の作業ツリーが clean か確認。dirty なら **integrate せず** その旨を報告
   (この tick では取り込まない)。
5. 揃ったら **`/integrate-worktree <id>` を起動** (Skill 経由)。
   - integrate-worktree は merge → conflict 解消 → check → gw end → simplify を行う。
   - **conflict 解消に設計判断が要る / check が落ちる** で詰まったら、強行せず中断し、
     `PushNotification` で「worktree <id> の取り込みが <理由> で詰まりました」と ping。
6. 取り込めた / 詰まった結果を簡潔に記録。

> 複数 ready があっても **1 tick で 1 worktree** にする (integrate-worktree の範囲外
> ポリシーに合わせる)。残りは次 tick で。

## B. spec groomer (分析中心)

`.feature-state/specs/*.md` を 1 つずつ評価する (read-only 中心)。

各 spec を以下の観点で判定:
- AC (受け入れ基準) が書かれているか
- open question / 未決の設計判断が残っていないか
- 依存 (他 spec / 他機能) が解決済みか
- scope の記載があるか

分類して報告:

- **着手 ready**: 上記が全部揃っている → 「`<id>` は着手 ready」と報告。
  必要なら「`gw start <id>` で worktree を切って feature-planner を起動できます」と
  提案する (worktree 作成・実装着手は user 判断、ここでは提案まで)。
- **not ready**: 何が欠けているか (AC 無し / open question 未決 等) を列挙。
- **stale 削除候補 (提案のみ・自動削除しない)**: 対応機能が main に integrate 済みに
  見える spec。判定根拠の例: 同名 task が `COMMITTED` かつ worktree が既に無い、かつ
  機能コードが main に存在。→ 「`<id>` は削除候補 (根拠: …)」と提示し、**削除は
  user 承認を待つ** (絶対に自分で消さない)。

## C. main 直作業の review watcher (品質系)

main に **直接** 積まれた作業 (worktree 経由でない) が **意味のある塊** になったら、
その範囲を `/code-review` でレビューする。worktree 経由の取り込みは integrate-worktree
の Step 7 (simplify) で既にレビュー済みなので、ここでは **二重レビューしない**。

### 状態

`.feature-state/orchestrate-state.json` の `lastReviewedMainSha` を基準にする。
- 無ければ初回は **現在の main HEAD で初期化**し (過去履歴は遡って review しない)、
  この tick の C は skip。
- 書き込みは tmp+rename で atomic に。

### 直作業の抽出

```
git log --first-parent --no-merges <lastReviewedMainSha>..main
```

- **`--first-parent`**: integrate-worktree の merge 経由で入った worktree の個別 commit を
  除外 (本流のみ歩く)。
- **`--no-merges`**: merge commit 自体も除外。
- → 残るのは **main の本流に直接積まれた非マージ commit** = 「main で直接作業されたもの」。

### 「意味のある塊」判定 (発火条件)

上記のうち **housekeeping を除いた実装 commit が 2 つ以上**あるとき発火する。
- housekeeping (除外): `docs(todo)` / `chore(.claude…)` / format-only / orchestrate の
  状態ファイル更新など、`packages/**` の source を触らない commit。
- 実装 commit: `packages/**` の source を触る `feat` / `fix` / `refactor` / `perf` /
  `test` 等。
- 閾値に満たない (0〜1 個) なら **`lastReviewedMainSha` を進めず** 次 tick へ持ち越し
  (溜まってからまとめて review)。

### レビュー実行

発火したら `<lastReviewedMainSha>..main` の直作業差分を `/code-review` でレビュー
(correctness bug + reuse / simplify / efficiency)。
- **low-risk な指摘**: main が clean なら直接修正して別 commit (例 `refactor(review): …`)。
- **main が dirty** (= user が作業中): 勝手に commit しない。指摘を**報告に留め**、適用は
  main clean 時 or user 承認後。
- **大きい / 判断系**: TODO 化、または重要なら `PushNotification` で ping。

### 後始末

レビューが終わったら `lastReviewedMainSha = 現在の main HEAD` に更新 (atomic)。
発火しなかった tick では更新しない (閾値到達まで蓄積)。

## 出力

- A で何かが起きた (integrate した / 詰まった / stale signal)、B で新規に ready / stale
  が出た、または C で review を実行した (指摘あり) 場合のみ、簡潔に報告。
- どれも変化なしなら「変化なし」一言で終える (毎 tick の冗長な列挙はしない)。

## loop との組み合わせ

```
/loop /crowi-orchestrate
```

で自律ループに乗せる。各 tick でこの skill が走り、loop 側が pacing と
「3 連続変化なしなら ping して縮退」等を司る。停止は `/loop stop`。
