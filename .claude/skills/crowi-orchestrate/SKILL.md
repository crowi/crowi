---
name: crowi-orchestrate
description: |
  main セッションで /loop から 1 tick ごとに呼ぶ前提のオーケストレーション skill。
  (A) ready for merge になった worktree を裏取りして integrate-worktree で取り込む、
  (B) specs/ を groom して着手 ready / 不足要素 / 削除候補を報告する、の 2 系統を
  実行する。push しない・spec を自動削除しない・詰まったら ping して待つ。
  キーワード: orchestrate, loop, watcher, integrate, groom, spec 整理
---

# Crowi Orchestrate (per-tick: ready worktree 取り込み + spec groom)

main セッションで `/loop /crowi-orchestrate` として **1 tick ごとに呼ばれる** 前提の
skill。単発 (`/crowi-orchestrate`) でも動く。2 系統を順に実行する。

**鉄則 (毎 tick 守る):**
- **push しない** (常にユーザー指示待ち)。
- **spec を自動削除しない** (削除は提案のみ、user 承認を待つ)。
- **main が dirty なら integrate しない** (skip して報告)。
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

## 出力

- A で何かが起きた (integrate した / 詰まった / stale signal) 、または B で
  新規に ready / stale が出た場合のみ、簡潔に報告。
- どちらも変化なしなら「変化なし」一言で終える (毎 tick の冗長な列挙はしない)。

## loop との組み合わせ

```
/loop /crowi-orchestrate
```

で自律ループに乗せる。各 tick でこの skill が走り、loop 側が pacing と
「3 連続変化なしなら ping して縮退」等を司る。停止は `/loop stop`。
