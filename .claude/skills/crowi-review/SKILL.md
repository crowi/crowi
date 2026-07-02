---
name: crowi-review
description: |
  Codex を敵対的レビュアーに使い、指定スコープ (worktree 差分 / main 直作業範囲 /
  エリア) を review → 報告 (+ main clean なら低リスクだけその場修正) する単発レビュー
  skill。findings は事前の全件検証をせず unverified タグ付きで報告し、修正を適用する
  ものだけ着手時に実コードで裏取りする (verification-on-action)。PR/merge の自動化は
  しない (crowi は main-direct + integrate-worktree のため)。Codex が落ちたら Claude
  subagent で代替。
  キーワード: review, code-review, codex, adversarial, レビュー, 品質
---

# Crowi Review

**Codex が敵対的レビュアー、Claude (あなた) がオーケストレータ + 修正者。**
review-gauntlet (lestrrat) のレビュー核 — codex 敵対レビュー → gate — を
crowi の運用 (main-direct) に合わせて **PR/merge のファンアウトを外した単発版**。

「連続的にかける」役割は **crowi-orchestrate C watcher** が持つ (C が本 skill を呼ぶ)。
本 skill 自体は 1 回のスコープを最後までやって終わる。自己ループ (`ScheduleWakeup`) は
持たない。

## 非目標 (取り込まないもの)

- **1 finding = 1 PR のファンアウト / 二重 SATISFIED gate / auto-merge** — crowi は
  main-direct + integrate-worktree なので PR 駆動 merge は思想が合わない。取り込まない。
- **push / PR 作成** — 常にユーザー指示待ち。
- **worktree の作成** — 修正は現在の作業ツリーに直接 (main clean 時のみ・下記)。
- **全 finding の事前 fleet 検証** — 廃止 (Claude のコード再読を削減)。裏取りは
  **修正を適用する finding だけ**、修正着手時に行う (verification-on-action)。

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
| `prompt.md` / `schema.json` | wrapper に渡すレビュー指示 + FINDINGS schema |
| `findings.json` (+ `.stderr` / `.log`) | Codex の構造化 findings (wrapper の out) |
| `report.md` | 最終報告 (severity 順 + unverified タグ。修正時に CONFIRMED / REFUTED へ更新) |

codex / subagent の出力は**まず `.reviews/crowi-review/` に書き**、そこから Read/Grep
する。`/tmp` は使わない。

## Stage 0 — Codex 敵対的レビュー (wrapper 経由)

すべての codex 呼び出しは **`.claude/scripts/codex-run.sh`** に集約する
(直接 `codex exec` を叩かない)。レビューは読み取り専用で完結し、findings は
`--out` に構造化 JSON で受け取る。

1. スコープを wrapper の引数に翻訳する:
   - 未コミット変更 → `--mode review --review-target "--uncommitted"`
   - ブランチ差分 → `--mode review --review-target "--base main"`
   - 単一 commit → `--mode review --review-target "--commit <sha>"`
   - **git range (`A..B`) / path・エリア** — review サブコマンドで表現できないので
     `--mode exec --sandbox read-only` に落とし、prompt に「`git diff A..B` を自分で
     実行して (または `<path>` 配下を読んで) レビューせよ」を含める。
2. 実行:

```bash
mkdir -p .reviews/crowi-review
cat > .reviews/crowi-review/prompt.md <<'PROMPT'
Perform an adversarial code review of <SCOPE>. For each finding give: a stable
id, severity (critical/high/medium/low), file (+ line when known), the defect,
a concrete reproduction trigger, the impact, and a concrete fix. Be hostile —
surface everything that could be wrong (correctness, security, resource/leak,
race, API/contract drift). Do NOT edit code. Do NOT run destructive git
commands. Return JSON matching the output schema.
PROMPT
cat > .reviews/crowi-review/schema.json <<'SCHEMA'
{ "type": "object", "required": ["findings"], "additionalProperties": false,
  "properties": { "findings": { "type": "array", "items": {
    "type": "object",
    "required": ["id", "severity", "file", "line", "defect", "trigger", "impact", "fix"],
    "additionalProperties": false,
    "properties": {
      "id": {"type": "string"},
      "severity": {"type": "string", "enum": ["critical", "high", "medium", "low"]},
      "file": {"type": "string"},
      "line": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
      "defect": {"type": "string"}, "trigger": {"type": "string"},
      "impact": {"type": "string"}, "fix": {"type": "string"}
    } } } } }
SCHEMA
bash .claude/scripts/codex-run.sh \
  --prompt-file .reviews/crowi-review/prompt.md \
  --schema-file .reviews/crowi-review/schema.json \
  --out .reviews/crowi-review/findings.json --label crowi-review \
  <上記 1 で決めた --mode / --review-target / --sandbox>
```

(schema は OpenAI strict 準拠 — `additionalProperties: false` + 全 property を
`required` に。緩めると codex が 400 で落ちる。)

3. exit code で分岐:
   - **0** → `findings.json` を読み Stage 1 へ。
   - **2 / 3**(codex 不可 / 出力不正。retry は wrapper 内蔵)→ **Claude fallback**:
     同じスコープの敵対レビューを `general-purpose` subagent に同じ FINDINGS 形式で
     書かせ、止まらない。報告に「Codex fallback (Claude subagent) で実行」と明記し、
     findings のタグは `unverified (claude-fallback)` にする。

大きいスコープはファイル群/エリアで区切って複数回に分けてよい。

## Stage 1 — 報告 (verification-on-action)

**全 finding の事前検証はしない。** `report.md` に severity 順で全 finding を列挙し、
各 finding に **`unverified (codex)`** タグ(fallback 時は `unverified (claude-fallback)`)
を付けて、そのまま会話でも報告する。critical / high があれば `PushNotification` で ping。

裏取りは**修正を適用する finding だけ**、修正着手時に行う(直すためにどうせコードを
読むので実質無料):

- 裏付けが取れた → 修正し、report のタグを **`CONFIRMED`** に更新。
- 実コードで反証された → **修正せず**、report のタグを **`REFUTED`** に更新
  (反証根拠 file:line を 1 行添える)。

修正しない finding は `unverified` のまま残る(ユーザー triage 用)。

## Stage 2 — 修正の扱い (低リスクのみその場修正)

crowi-orchestrate C と同じルール:

- **main が clean** かつ **low-risk** (局所・挙動不変・テスト裏付け可) → 裏取り
  (上記) の上でその場で修正し **別 commit** (`fix(review): …` / `refactor(review): …`)。
  type-check / test / lint が通ることを確認してから commit。
- **main が dirty** (ユーザー作業中) → 勝手に commit しない。**報告に留め**、適用は
  main clean 時 or ユーザー承認後。
- **大きい / 判断系** → TODO 化 (`docs(todo)`)、重要なら ping。
- **push / PR はしない**。commit までで止め、push はユーザー指示待ち。

> API surface/behavior を変える修正は勝手に入れない (report に留めて確認を仰ぐ)。

## crowi-orchestrate / integrate-worktree との連携

- **crowi-orchestrate C**: main 直作業が閾値に達したら、本 skill を
  `<lastReviewedMainSha>..main` スコープで呼ぶ (C 系統の既定)。
  発火条件・`lastReviewedMainSha` 更新は C 側のまま。
- **integrate-worktree Step 7**: simplify (Claude 3 agent) の敵対レビュー版として、
  統合差分 (`git diff <merge>^..HEAD`) に本 skill をかけてもよい。simplify は
  reuse/quality/efficiency、本 skill は correctness/security の敵対レビューで役割が違う
  (併用可)。

## ルール

- codex は必ず `.claude/scripts/codex-run.sh` 経由で呼ぶ (レビューは read-only で完結。
  `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` は使わない)。
- Codex に破壊的操作 (delete / force-push / reset) を渡さない。
- 修正は現在の作業ツリーに **順次** 適用 (並列 subagent で同一ツリーを編集しない)。
  ファンアウトが要るレベルなら worktree を切る運用 (整合は integrate-worktree) に回す。
- main dirty 時は commit しない。push は常にユーザー指示待ち。
- 出力は `.reviews/crowi-review/` に置く (`/tmp` 不可・commit 不可)。
