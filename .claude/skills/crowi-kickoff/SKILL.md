---
name: crowi-kickoff
description: |
  承認済み spec から worktree 実装開始までを 1 コマンド化。ready 判定 → gw start
  (hook が tmux window + claude セッションを自動起動) → queue 初期化 → その window に
  実装指示を send-keys で投入。main worktree で実行する。not ready な spec は欠落を
  列挙して中止する。
  キーワード: kickoff, 着手, 実装開始, worktree 開始, start, spec 着手
---

# Crowi Kickoff (spec → worktree 実装開始)

承認済み spec の実装着手を 1 コマンドにする skill。これまで手動だった
「`gw start` → tmux window → エージェント起動 → `/crowi-feature` 手打ち」を自動化し、
開発ループの**入口**を閉じる(出口は `/crowi-complete-feature` + orchestrate A)。

## 起動例

```
/crowi-kickoff feature-attachment-thumbnail
/crowi-kickoff attachment-thumbnail            # feature- prefix は省略可
/crowi-kickoff feature-foo --no-launch         # worktree 作成まで。指示投入はしない
```

## 前提(実測済みの環境)

- `gw start <id>` は `~/.gwrc` の post_start_hook で
  1. `~/.gw/hooks/feature-state-link.sh` — worktree 側 `.feature-state/` を作成し
     specs/ tasks/ config.json を main store へ symlink、`queue.json` を
     `{ "currentTask": null }` で seed(worktree ローカル)
  2. `tmux new-window -c <worktree> -n <branch名> "claude"` — **claude セッションを自動起動**
  を実行する。**したがって kickoff がセッションを spawn する必要はない** —
  gw が開いた window に指示を send-keys で投入するだけでよい
  (agmsg spawn で別セッションを立てると二重になる。やらない)。
- worktree dir は `../crowi-<id>`、branch は `<id>/impl` 形式、window 名 = branch 名。

## ワークフロー

### Step 1: 引数解決 + 実行コンテキスト確認

- spec-id は `feature-` prefix の有無どちらも受ける:
  ```bash
  ls .feature-state/specs/*.md 2>/dev/null | grep -E "(^|/)(feature-)?<入力>\.md$"
  ```
  複数一致なら列挙して中止。
- **0 件なら wiki を確認**(pull・一方向): `crowi_get_page` で `/crowi/spec/<入力>` →
  無ければ `/crowi/spec/feature-<入力>` も試す。見つかったら body を
  `.feature-state/specs/<id>.md` に書き出して(「wiki から pull した」と報告)続行。
  pull した spec も Step 2 の ready 判定は通常どおり行う(wiki にあるからと言って
  ready とは限らない)。MCP 未接続なら「specs/ に無い(wiki は未確認: MCP 未接続)」で中止。
  wiki にも無ければ「spec が無い」で中止。

  **wiki との正本ルール**(crowi-design と共通): 作業中の正本は `.feature-state/specs/`、
  wiki `/crowi/spec/<id>` は耐久スナップショット。同期は一方向のみ(design → wiki の
  publish / wiki → specs/ のこの pull)。食い違ったら `.feature-state/specs/` が勝つ。
- **main worktree で実行していること**(`git worktree list` の先頭パスと
  `git rev-parse --show-toplevel` が一致)。worktree 内からの実行は中止
  (「kickoff は main セッションから」)。main が dirty でも kickoff 自体は可
  (worktree を切るだけで main を触らない)。

### Step 2: ready 判定(orchestrate B と同一基準)

spec を読み、以下すべてを確認。1 つでも欠けたら**欠落を列挙して中止**
(勝手に補完・書き換えしない):

1. frontmatter に `scope` がある
2. `## 受け入れ基準` セクションが存在し空でない
3. `## 未確定事項 (open questions)` に**実装をブロックする未決**が無い。
   「→ 既定: ...」形式で既定解が書いてある項目はブロックしない。
   既定なしの設計判断が残っていればブロック。
4. status(frontmatter or 本文)が NEEDS_WORK / draft を明示していない

### Step 3: 重複ガード

- `git worktree list` に `crowi-<id>` を含む行があれば中止(「着手済み。続きはその worktree で」)。
- `.feature-state/tasks/<id>.json` が存在し status が
  `PLANNED / IN_PROGRESS / REVIEW / NEEDS_WORK / READY_TO_INTEGRATE` なら中止(進行中 or 統合待ち)。
  `COMMITTED` / `INTEGRATED` の化石なら警告つきで続行可(再着手のケース)。

### Step 4: worktree 作成 + queue 初期化

```bash
gw start <id>        # hook が .feature-state 配線 + tmux window + claude 起動までやる
```

- **gw が無い環境では中止**(`git worktree add` 直呼びはしない — 既存規約)。
- hook が seed した worktree 側 `queue.json` の `currentTask` を上書き(tmp+rename で atomic):

```bash
WT="../crowi-<id>"
printf '{ "currentTask": "%s", "lastUpdated": "%s" }\n' "<id>" "$(date -u +%FT%TZ)" \
  > "$WT/.feature-state/queue.json.tmp" && mv "$WT/.feature-state/queue.json.tmp" "$WT/.feature-state/queue.json"
```

### Step 5: 実装指示の投入(gw が開いた window へ send-keys)

1. window を特定: `tmux list-windows -a -F '#{window_id}|#{window_name}'` から
   window 名 = branch 名(`<id>/impl`)の行。見つからなければ
   `pane_current_path` が worktree 配下の window を探す。
2. **claude の起動完了を待つ**: 対象 pane の `pane_current_command` が
   バージョン形式(`2.x.x`)になるまで 2 秒間隔で poll(上限 60 秒)。
3. 指示を投入(入力 → 1 秒待ち → Enter。slash メニューの誤発火を避けるため
   **平文で書き、行頭を `/` にしない**):

```bash
tmux send-keys -t "<window>" \
  "crowi-kickoff からの指示です。/crowi-feature <id> を実行してください。COMMITTED まで完走したら /crowi-complete-feature、中断・引き継ぎ時は /crowi-handoff を実行。push は禁止(ユーザー指示待ち)。"
sleep 1
tmux send-keys -t "<window>" Enter
```

4. **fallback**: tmux 環境でない / window が見つからない / 60 秒待っても claude が
   起動しない → 投入せず、手動手順を表示して終わる(中止ではない — worktree は
   作成済みなので Step 6 の報告に含める):

```
cd <worktree-abs-path> && claude
→ 最初に: /crowi-feature <id>
→ 完了時: /crowi-complete-feature / 中断時: /crowi-handoff
```

`--no-launch` 指定時は Step 5 全体を skip して手動手順の表示のみ。

### Step 6: 報告

- worktree path / branch / window(投入済み or 手動手順)
- 次に人間がやること(通常なし。spec が multi-phase で gated phase を含むならその旨)

## 鉄則

- **push しない** / **spec を書き換えない** / **not ready を勝手に ready 扱いしない**
- worktree は gw 経由のみ(`git worktree add/remove` 直呼び禁止)
- 投入する指示は**最初の 1 通のみ**。以後 worktree セッションの作業に割り込まない
  (進捗の把握は orchestrate A/E と agmsg 側に任せる)

## エッジケース

| ケース | 挙動 |
|---|---|
| spec が specs/ に無い | wiki `/crowi/spec/<id>` から pull を試みる(Step 1)。wiki にも無ければ中止 |
| gw start 失敗(同名 branch 残骸等) | gw のエラーを提示して中止。`-f` 系は使わずユーザーに委ねる |
| claude 起動待ち timeout | 手動手順を表示(worktree は残す) |
| send-keys 後に反応が無い | 追いパンチしない。報告に「投入したが未確認」と書き、ユーザーに window 確認を促す |

## crowi-feature / complete-feature との関係

- worktree 名 = spec id にするのは、`/crowi-complete-feature` の id 解決
  (dir basename から `crowi-` 除去)と orchestrate A の worktree 特定
  (worktree 名 = task id)を成立させるため。**変えない**。
- kickoff は planner を起動しない(それは worktree 側の `/crowi-feature` が
  scope 判定して行う)。kickoff の責務は「入口を開けて最初の指示を渡す」まで。
