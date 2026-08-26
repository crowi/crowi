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
/crowi-kickoff feat-a feat-b feat-c            # 直列チェーン: 先頭だけ起動し、integrate 完了ごとに次を自動 kickoff
```

## 直列チェーン(複数 spec を順番に)

複数の spec id を渡すと、**1 本ずつ直列**に流す(並列に全部起動しない)。先頭だけを
今 kickoff し、`/integrate-worktree` がそれを main に統合し終えた時点で次を自動 kickoff
する。整合の要る feature を順に着地させたい / 並列 worktree を増やしたくないときに使う。

- **前提チェックは全 spec ぶん先にやる**(Step 1-3 を渡された全 id に対して実行)。1 つでも
  not-ready / 重複なら、**チェーンを一切開始せず**欠落を列挙して中止する(途中で詰まる
  連鎖を作らない)。全 id が ready のときだけ進む。
- 先頭 id だけ Step 4-5(worktree 作成・起動・指示投入)を行う。残りは起動しない。
- チェーン状態を `<stateDir>/kickoff-chain.json` に atomic (tmp+rename) で書く:
  ```json
  { "after": "feature-<先頭id>", "then": ["feature-<2番目>", "feature-<3番目>"], "createdAt": "<UTC>" }
  ```
  `after` = 「これが integrate されたら次へ」の現在待ち id、`then` = 以降のキュー。
  `then` が空になる単一 id 指定のときはこのファイルを作らない(通常の単発 kickoff と同じ)。
- Step 5.7 の watch は先頭 1 回だけ張ればよい(以降のチェーン前進は integrate 側が担う)。
- **チェーンの前進は `/integrate-worktree` の最終ステップ (Step 9) が行う** — integrate が
  `after` に一致する id を統合し終えたら、`then[0]` を次として `/crowi-kickoff` し、
  ファイルを更新/削除する。詳細は integrate-worktree Step 9。
- 途中の spec が NEEDS_WORK/ESCALATE で READY にならなければ、そこで連鎖は自然に一時停止
  する(次に進まない)。再開したい場合は当該 spec を仕上げて integrate すれば連鎖が続く。
- 報告(Step 6)には「チェーン: 先頭 <id> 起動、以降 <then> を integrate ごとに自動着手」
  と 1 行含める。

## 前提(実測済みの環境)

- `gw start <id>` は post_start_hook で
  1. `.gw/feature-state-link.sh` — worktree 側 `.feature-state/` を作成し
     specs/ tasks/ config.json を main store へ symlink、`queue.json` を
     `{ "currentTask": null }` で seed(worktree ローカル)
  2. `.gw/tmux-claude.sh` で `tmux new-window -n <window 名>` に **claude セッションを自動起動**
  を実行する。**したがって kickoff がセッションを spawn する必要はない** —
  gw が開いた window に指示を send-keys で投入するだけでよい
  (agmsg spawn で別セッションを立てると二重になる。やらない)。
  - **起動フラグ・hook は crowi の project-local `.gwrc`(repo root・gitignore 済み)で
    override**している。hook スクリプトは **`./.gw/`(repo-local・home 非依存)** に置き、
    `.gwrc` は `$GW_WORKTREE_PATH` から main worktree root を導出して `$MAIN/.gw/*.sh` を
    呼ぶ(CWD にも `~` にも依存しない)。`.gw/tmux-claude.sh` は
    `claude --remote-control '<repo>:<id>' --name '<repo>:<id>'` で起動し、RC 有効 +
    session/terminal title = `<repo>:<id>`(例 `crowi:live-page-sync-reconcile`)にする。
    kickoff 後に質問で止まった session を picker/title で見つけて remote で動かすため。
    crowi の `.gwrc` だけの override で `~/.gwrc`(global)は触らない。
    **前提: gw が project-local `.gwrc` を読むビルドであること**(gw の
    `feature-project-local-config` 機能。未対応バイナリでは global の素 `claude` 起動に
    fall back = RC/name 無し)。`.gwrc` を編集すると direnv 式 trust hash が変わるので、
    次の `gw start` で trust 再承認プロンプトが出る(承認まで global 値に fall back)。
  - なお claude は RC/name 付きでも `pane_current_command` は version 文字列(`2.x.x`)の
    ままなので、Step 5 の pane 検出は不変。
- hook 構成によってはさらに **右 pane に `pnpm dev` が自動分割起動**される
  (`split-window -d` — dev-portal の anchor 自動採番で port 衝突しない。
  `GW_NO_DEV=1 gw start <id>` でスキップ可)。このため**指示の投入先は
  window ではなく claude の pane_id を明示指定**する(Step 5)。
- worktree dir は `../crowi-<id>`、branch は `<id>/impl` 形式、**window 名は branch から
  `/impl` を落としたもの**(= `<id>`)。全 worktree branch が `/impl` で終わる以上この
  suffix は情報量ゼロで、ただでさえ切り詰められる tab bar を 5 桁食うだけなので落とす。
  **window 名に依存する処理は無い** — kickoff も integrate-worktree も
  `pane_current_path` で window を引くので、名前は表示専用と考えてよい。

## ワークフロー

### Step 1: 引数解決 + 実行コンテキスト確認

- spec-id は `feature-` prefix の有無どちらも受ける:
  ```bash
  ls .feature-state/specs/*.md 2>/dev/null | grep -E "(^|/)(feature-)?<入力>\.md$"
  ```
  複数一致なら列挙して中止。
- **0 件なら wiki を確認**(pull・一方向): **crowi CLI の直リダイレクトで materialize する**
  (取得本文をモデルが Write で書き起こす転記経路を、実装の入口に置かない):
  ```bash
  mkdir -p .feature-state/specs   # bash redirect は親ディレクトリを作らない
  crowi -p local get "/crowi/spec/<入力>" > ".feature-state/specs/<id>.md" \
    || crowi -p local get "/crowi/spec/feature-<入力>" > ".feature-state/specs/<id>.md"
  # 検証: live と一致するか (末尾改行 1 行だけの差は一致とみなす)
  crowi -p local get "/crowi/spec/<id>" | diff - ".feature-state/specs/<id>.md"
  ```
  見つかったら「wiki から pull した」と報告して続行。pull した spec も Step 2 の ready 判定は通常どおり行う(wiki にあるからと言って ready とは限らない)。CLI が使えない環境に限り `crowi_get_page` (MCP) を fallback にしてよいが、その場合も書き出した内容を live と diff で突合してから進む。wiki にも無ければ「spec が無い」で中止。

  **wiki との正本ルール**(crowi-design と共通): 作業中の正本は `.feature-state/specs/`、
  wiki `/crowi/spec/<id>` は耐久スナップショット。同期は一方向のみ(design → wiki の
  publish / wiki → specs/ のこの pull)。食い違ったら `.feature-state/specs/` が勝つ。
- **main worktree で実行していること**(`git worktree list` の先頭パスと
  `git rev-parse --show-toplevel` が一致)。worktree 内からの実行は中止
  (「kickoff は main セッションから」)。main が dirty でも kickoff 自体は可
  (worktree を切るだけで main を触らない)。

### Step 2: implementation-ready 判定(orchestrate B と同一基準)

`.claude/skills/_shared/spec-contract.md` が正本。repo root で validator を実行する:

```bash
bash .claude/skills/_shared/validate-implementation-spec.sh ".feature-state/specs/<id>.md"
```

exit 0 のときだけ続行する(`WARN:` が stderr に出ていても exit 0 なら着手を止めない — symbol 粒度の freshness 判定が「共有ファイルへの無関係な変更」を soft に落としたもので、hard stale ではない)。validator は次をまとめて検証する:

- contract v2 marker(`spec_contract: 2` / `status: approved` / `implementation_ready: true`)
- `scope` / AC / blocking open question 無し
- path + symbol 単位の実装マップ、処理フロー、契約・不変条件、実装順序
- stable AC ID と test file/case/level の対応
- `grounded_at` が有効で、参照 path が以後の commit / working tree で変化していない(生成物 — lockfile / OpenAPI / `**/generated/**` — は staleness 判定から除外される。参照 path が symbol 単位で保守的な 5 条件を満たせば、シンボル行が変わっていない限り `WARN:` に落ちる — 詳細は `.claude/skills/_shared/spec-contract.md` の freshness の symbol 粒度節)

複数 spec を preflight する場合は、各 spec の validator 実行について **stdout・stderr・exit status を spec id と対応づけて**リクエスト内に保持する(spec をまたいで混ざらないようにするため)。exit 0 の全 spec について、保持した stderr に `WARN:` 行があれば **spec id ごとに原文のまま**保持しておく(Step 6 で報告するため)。

**umbrella spec**(`kind: umbrella`)はこの経路に入らない。umbrella は運用契約とフェーズ表だけを持ち AC も実装マップも持たないのが正しい形なので、validator は代わりに **`phases:` の各 sub-spec が実在しそれ自体が v2 を通ること**を検証する(厳しさは sub-spec へ委譲される)。kickoff 側の手順は変わらず、worktree 名も umbrella の id を使う — 単一 worktree で全フェーズを回す運用契約は umbrella が持っており、sub-spec を個別に kickoff するとその契約が失われるため。

失敗時は validator の `ERROR:` を欠落・stale 理由として列挙して中止する。
**kickoff 側で spec を補完・書き換えない。** legacy spec は直接 `/crowi-feature` の
planner fallback で実装できるが、安価なモデルへ設計判断を残さない kickoff 経路には入れない。
`/crowi-design spec <topic>` で v2 に作り直すか、既存 spec を強いモデルで v2 へ更新して
再レビューする。

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
- hook が seed した worktree 側 `queue.json` の `currentTask` を上書き。
  `queue.json` への直接 Write/Edit は PreToolUse hook が拒否するので、
  worktree 側の `task-state.sh` を経由する(script 自身が tmp+不変条件検証+atomic
  rename+`.bak` を行う):

```bash
WT="../crowi-<id>"
bash "$WT/.claude/scripts/task-state.sh" queue set-current "<id>"
```

### Step 5: 実装指示の投入(gw が開いた window へ send-keys)

1. window を特定: **`pane_current_path` が worktree 配下にある window** を探す
   (window 名ではなくパスで引く — 名前は表示上の都合でいつでも変わりうるが、
   パスは worktree の同一性そのもの。integrate-worktree Step 6.5 も同じ引き方):

   ```bash
   tmux list-panes -a -F '#{window_id}|#{pane_current_path}' \
     | awk -F'|' -v p="<worktree-abs-path>" '$2 ~ "^"p"(/|$)" {print $1}' | sort -u
   ```

   補助的に window 名(= branch から `/impl` を除いたもの)でも引けるが、
   一致しないことを理由に中止しない。
2. **claude の pane を特定して起動完了を待つ**: hook 構成によっては window に
   dev pane(右・`pnpm dev`)が併設されるため、**window 宛(= アクティブ pane 宛)の
   send-keys は使わない**。`tmux list-panes -t <window> -F '#{pane_id}|#{pane_current_command}'`
   で `pane_current_command` がバージョン形式(`2.x.x`)の pane が現れるまで
   2 秒間隔で poll(上限 60 秒)し、その **pane_id** を投入先にする。
3. **まず実装モデルへ切り替える**(hook の plain `claude` は既定モデル = 高価な
   session model で起動するため。実装は sonnet で十分な設計 — spec が
   implementation-ready であることは ready 判定済み):

```bash
tmux send-keys -t "<claude の pane_id>" "/model sonnet"
sleep 1
tmux send-keys -t "<claude の pane_id>" Enter
sleep 2
```

4. **agmsg の受信を自分宛だけに絞る**。`watch.sh` は role 名を渡さないと
   **そのプロジェクトに登録された全 (team, agent) ペア**を購読するので、既定のままだと
   worktree セッションに manager⇄planner のやり取りまで流れ込む(実測。impl セッションが
   自分宛でない版数の議論を読まされ、そのぶんのトークンと注意を払っていた)。role 名は
   **spec id をそのまま使う**(worktree 名・task id と同じ値にして、どのセッションの
   role かを一意にする)。`actas` は未登録なら join も行うので事前の join は要らない:

```bash
tmux send-keys -t "<claude の pane_id>" "/agmsg actas <id>"
sleep 1
tmux send-keys -t "<claude の pane_id>" Enter
sleep 3
```

   投入した role は **worktree セッション自身が終端で drop する**
   (`/crowi-complete-feature` か `/crowi-handoff`)。`actas` の排他ロックは
   セッション ID に紐づくので、main 側から外して回ることはできない。

5. 指示を投入(入力 → 1 秒待ち → Enter。slash メニューの誤発火を避けるため
   **平文で書き、行頭を `/` にしない**):

```bash
tmux send-keys -t "<claude の pane_id>" \
  "crowi-kickoff からの指示です。/crowi-feature <id> を実行してください。COMMITTED まで完走したら /crowi-complete-feature、中断・引き継ぎ時は /crowi-handoff を実行。push は禁止(ユーザー指示待ち)。"
sleep 1
tmux send-keys -t "<claude の pane_id>" Enter
```

**送信確認(必須)**: セッション初期化直後は Enter が入力欄に届かず、指示文が
**未送信のまま入力欄に残る**ことがある(実例 2026-07-19: redis-docs-page が
1 時間 0 commit — capture-pane で入力欄に指示が残っているのを発見)。Enter の
2-3 秒後に `tmux capture-pane -t <pane_id> -p | tail -8` で入力欄(`❯` 行)が
**空になっている**ことを確認し、指示文が残っていれば **Enter を 1 回だけ再送**
して再確認する。それでも残る場合は追いパンチせず「投入したが未送信の可能性」
として報告する(このリトライは初回指示の配送完了であり、鉄則の「指示は 1 通
のみ」の例外ではない — 新しい内容は送らない)。

6. **fallback**: tmux 環境でない / window が見つからない / 60 秒待っても claude が
   起動しない → 投入せず、手動手順を表示して終わる(中止ではない — worktree は
   作成済みなので Step 6 の報告に含める):

```
cd <worktree-abs-path> && claude
→ 最初に: /agmsg actas <id>        (受信を自分宛に絞る。省くと他 role 宛まで流れ込む)
→ 次に:   /crowi-feature <id>
→ 完了時: /crowi-complete-feature / 中断時: /crowi-handoff
```

`--no-launch` 指定時は Step 5 全体を skip して手動手順の表示のみ。

### Step 5.7: orchestrate watch を張る(main セッション側・未起動なら)

worktree 側の完了は `/crowi-complete-feature` が `.feature-state/tasks/<id>.json` に立てる
`READY_TO_INTEGRATE` signal で伝わる(shared store 経由 = agmsg 等のチーム基盤に依存しない
repo-native の契約)。ただし signal は **push されない**ので、kickoff した main セッションは
`orchestrate-watch.sh` を Monitor で常駐させて検知する(TaskList に「orchestrate watch」が
既にあれば張り直さない。event 対応表は crowi-orchestrate の「運用モード: watch」節が正本):

```
Monitor({ command: 'bash .claude/scripts/orchestrate-watch.sh',
          description: 'orchestrate watch (A/C/D/E lanes)', persistent: true })
```

signal を受けたら orchestrate A と同じ裏取り(clean / headSha 一致 / main clean)をして
`/integrate-worktree <id>` へ。agmsg の完了通知(handoff skill の任意送信)は
**二次チャネル** — 正はこの signal file。

### Step 6: 報告

- worktree path / branch / window(投入済み or 手動手順)
- signal watcher を張った(or 既存)ことを 1 行
- 次に人間がやること(通常なし。spec が multi-phase で gated phase を含むならその旨)
- **staleness warnings**: Step 2 で保持した `WARN:` がある spec id ごとに見出しを立て、配下に validator の raw `WARN:` 行を原文のまま転記する(要約・書き換えしない)。`WARN:` が無かった spec には見出しを出さない。

```
staleness warnings:

## feature-<id>
WARN: referenced path changed but grounded symbol lines are identical: <path> (symbols: <...>)
```

## 鉄則

- **push しない** / **spec を書き換えない** / **not ready を勝手に ready 扱いしない**
- worktree は gw 経由のみ(`git worktree add/remove` 直呼び禁止)
- 投入する指示は**最初の 1 通のみ**。以後 worktree セッションの作業に割り込まない
  (進捗の把握は orchestrate A/E と agmsg 側に任せる)

## エッジケース

| ケース | 挙動 |
|---|---|
| spec が specs/ に無い | wiki `/crowi/spec/<id>` から pull を試みる(Step 1)。wiki にも無ければ中止 |
| legacy / incomplete spec | validator の欠落を列挙して中止。`/crowi-design spec` で v2 化するか、直接 `/crowi-feature` の planner fallback を明示的に使う |
| 引用 symbol の行が `grounded_at` 後に変わった(symbol line hard stale) | `ERROR:` で中止(exit 1)。安価な planner で黙って再設計せず、spec を再 ground / review する |
| path-only 参照、または symbol 粒度の 5 条件を満たさない変化(mode 不一致・binary・dirty 等、file-level hard stale) | `ERROR:` で中止(exit 1)。symbol hard stale と同様に再 ground / review する |
| symbol 外の変更だけが起きた(共有ファイルへの無関係な追加など) | `WARN:` は出るが exit 0。着手は止めない。Step 6 の staleness warnings に転記する |
| gw start 失敗(同名 branch 残骸等) | gw のエラーを提示して中止。`-f` 系は使わずユーザーに委ねる |
| claude 起動待ち timeout | 手動手順を表示(worktree は残す) |
| send-keys 後に反応が無い | 追いパンチしない。報告に「投入したが未確認」と書き、ユーザーに window 確認を促す |
| spec が umbrella(他 spec をフェーズとして参照する形式) | kickoff の手順自体は変わらない(通常どおり `/crowi-feature <id>` を投入)。umbrella は spec_contract の値に関わらず crowi-feature SKILL 側で needsPlanner=true に倒される(v2 fast path はどの spec からも sub-spec phases を機械導出できないため)。feature-planner が `phases:` の sub-spec 群から実装順序 / `extraGates` / `longLived` 相当を task state へ seed する。 |

## crowi-feature / complete-feature との関係

- worktree 名 = spec id にするのは、`/crowi-complete-feature` の id 解決
  (dir basename から `crowi-` 除去)と orchestrate A の worktree 特定
  (worktree 名 = task id)を成立させるため。**変えない**。
- kickoff は planner を起動しない(それは worktree 側の `/crowi-feature` が
  scope 判定して行う)。kickoff の責務は「入口を開けて最初の指示を渡す」まで。
