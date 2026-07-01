---
name: crowi-review
description: |
  Codex を敵対的レビュアーに使い、指定スコープ (worktree 差分 / main 直作業範囲 /
  エリア) を review → Claude subagent で中立検証 → 報告 (+ main clean なら低リスク
  だけその場修正) する単発レビュー skill。PR/merge の自動化はしない (crowi は
  main-direct + integrate-worktree のため)。Codex が落ちたら Claude subagent で代替。
  キーワード: review, code-review, codex, adversarial, レビュー, 品質
---

# Crowi Review

**Codex が敵対的レビュアー、Claude (あなた) がオーケストレータ + 修正者。**
review-gauntlet (lestrrat) のレビュー核 — codex 敵対レビュー → 中立検証 → gate — を
crowi の運用 (main-direct) に合わせて **PR/merge のファンアウトを外した単発版**。

「連続的にかける」役割は **crowi-orchestrate C watcher** が持つ (C が本 skill を呼ぶ)。
本 skill 自体は 1 回のスコープを最後までやって終わる。自己ループ (`ScheduleWakeup`) は
持たない。

## 非目標 (取り込まないもの)

- **1 finding = 1 PR のファンアウト / 二重 SATISFIED gate / auto-merge** — crowi は
  main-direct + integrate-worktree なので PR 駆動 merge は思想が合わない。取り込まない。
- **push / PR 作成** — 常にユーザー指示待ち。
- **worktree の作成** — 修正は現在の作業ツリーに直接 (main clean 時のみ・下記)。

## 引数とスコープ解決

`/crowi-review [scope]`

`scope` の解決順 (最初に当たったもの):

1. **明示引数** — path / エリア名 (`packages/api/src/hono` 等) or git range
   (`abc123..HEAD`) が渡されたらそれ。
2. **未コミット変更がある** (`git status --porcelain` 非空) → 作業ツリー差分
   (`git diff HEAD`) をレビュー。
3. **ブランチが main 以外** → `main...HEAD` (ブランチが積んだ差分)。
4. **main 上** → 直近の実装 commit 範囲。crowi-orchestrate C 経由なら
   `<lastReviewedMainSha>..main` が渡ってくる前提。単発起動時は直近 1 commit
   (`HEAD~1..HEAD`) を既定にし、範囲が欲しければ引数で渡すよう促す。

解決したスコープ (range or path) を **1 回だけ確定**し、以降ぶらさない。

## 状態ファイル

すべて `.reviews/crowi-review/` 配下 (gitignore 済み・commit しない):

| ファイル | 内容 |
|---|---|
| `findings-raw.md` | Codex の生の敵対的 findings |
| `verdicts.md` | 中立検証の判定 (survive するもの) |
| `report.md` | 最終報告 (survivors + REFUTED/UNCERTAIN) |

codex / subagent の出力は**まず `.reviews/crowi-review/` に書き**、そこから Read/Grep
する。`/tmp` は使わない。

## Codex fallback — quota / system error

`codex exec` が **verdict/findings を返さない** 失敗 (quota・rate-limit・auth・timeout・
その他 system error) をしたら、**verdict の不在**として扱う (実際に findings や
`VERDICT:` 行を返したら、それは結果なので採用する)。

失敗時: **1 回リトライ**。それでもダメなら **同じ仕事を Claude subagent で代替**して
止まらない — Stage 0 なら `Explore` / `general-purpose` subagent で同スコープの敵対
レビューを `findings-raw.md` に書く。報告に「Codex fallback (Claude subagent) で実行」
と明記する。これは system 失敗時の代替であって、Codex が動くなら常に Codex を使う。

## Stage 0 — Codex 敵対的レビュー

スコープの差分に対し codex を回す (`--full-auto`、コードは編集させない):

```bash
mkdir -p .reviews/crowi-review
codex exec --full-auto -o .reviews/crowi-review/findings-raw.md \
  "Perform an adversarial code review of the git diff for <SCOPE> \
   (run: git diff <RANGE>  — or review the files under <PATH>). For each finding give: \
   a stable ID, severity (critical/high/medium/low), file:line, the defect, a concrete \
   reproduction trigger, the impact, and a concrete fix. Be hostile — surface everything \
   that could be wrong (correctness, security, resource/leak, race, API/contract drift). \
   Do NOT edit code. Do NOT run destructive git commands."
```

- codex は `--full-auto` で shell を持つので、`git diff <RANGE>` を自分で取れる。大きい
  スコープはファイル群/エリアで区切って複数回に分けてよい。
- 落ちたら「Codex fallback」に従い subagent で同等の敵対レビューを書く。

## Stage 1 — 中立検証 (Claude subagent)

`findings-raw.md` の各 finding を **refute 寄り**で監査し
`CONFIRMED` / `ADJUSTED` / `REFUTED` / `UNCERTAIN` を付けて `verdicts.md` に書く。
検証は **Codex ではなく Claude subagent** が行う (レビュアーと検証者を分離 = 独立性)。

- **findings ≤ 10** → `Explore` subagent 1 つが全件監査 (全体が見えるので取りこぼし無し)。
- **findings > 10** → 5〜8 件ずつ shard し、chunk ごとに `Explore` subagent を並列起動
  → `verdicts-<chunk>.md` に書き、最後に結合。shard 時は結合後に自分で dedup
  (同一バグを指す finding を 1 件に畳む)。

各 subagent には「コードを実際に読んで再現可否を確認、**疑わしきは REFUTED に倒す**、
CONFIRMED には file:line と最小再現根拠を付ける」を指示する。

**CONFIRMED / ADJUSTED のみ**を work item として残す。REFUTED は捨て、UNCERTAIN は
報告でユーザー triage に回す。survive 0 件なら「指摘なし」で報告して終了。

## Stage 2 — 報告 (+ 低リスクのみその場修正)

1. **報告 (`report.md` + 会話)**: survivors を severity 順に列挙 (file:line + 修正案)。
   UNCERTAIN も別掲。critical/high があれば `PushNotification` で ping。
2. **修正の扱い** (crowi-orchestrate C と同じルール):
   - **main が clean** かつ **low-risk** (局所・挙動不変・テスト裏付け可) → その場で修正し
     **別 commit** (`fix(review): …` / `refactor(review): …`)。type-check / test / lint が
     通ることを確認してから commit。
   - **main が dirty** (ユーザー作業中) → 勝手に commit しない。**報告に留め**、適用は
     main clean 時 or ユーザー承認後。
   - **大きい / 判断系** → TODO 化 (`docs(todo)`)、重要なら ping。
3. **push / PR はしない**。commit までで止め、push はユーザー指示待ち。

> API surface/behavior を変える修正は勝手に入れない (report に留めて確認を仰ぐ)。

## crowi-orchestrate / integrate-worktree との連携

- **crowi-orchestrate C**: main 直作業が閾値に達したら、組み込み `/code-review` の代わりに
  本 skill を `<lastReviewedMainSha>..main` スコープで呼べる (Codex レビューに置換)。
  発火条件・`lastReviewedMainSha` 更新は C 側のまま。
- **integrate-worktree Step 7**: simplify (Claude 3 agent) の敵対レビュー版として、
  統合差分 (`git diff <merge>^..HEAD`) に本 skill をかけてもよい。simplify は
  reuse/quality/efficiency、本 skill は correctness/security の敵対レビューで役割が違う
  (併用可)。

## ルール

- Codex に破壊的操作 (delete / force-push / reset) を渡さない。`--full-auto` を使い
  `--dangerously-bypass-approvals-and-sandbox` は使わない。
- レビュアー (Codex) と検証者 (Claude subagent) を分離する — 同じ主体に self-review
  させない。
- 修正は現在の作業ツリーに **順次** 適用 (並列 subagent で同一ツリーを編集しない)。
  ファンアウトが要るレベルなら worktree を切る運用 (整合は integrate-worktree) に回す。
- main dirty 時は commit しない。push は常にユーザー指示待ち。
- 出力は `.reviews/crowi-review/` に置く (`/tmp` 不可・commit 不可)。
