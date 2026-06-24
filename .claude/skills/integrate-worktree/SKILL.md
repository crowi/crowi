---
name: integrate-worktree
description: |
  完了した並行 worktree の作業を main に取り込み、worktree を close、その後 simplify で
  統合後のコードを整える一連のワークフロー。複数エージェントが gw worktree で並行作業して
  いる時に、ひとつ終わったブランチを main に合流させる時に使う。
  キーワード: worktree, merge, integrate, gw end, 統合, 取り込み
---

# Integrate Worktree

並行 worktree の完了作業を **main にマージ → worktree を close → simplify で整える** までを
一気通貫で実行する skill。`gw` ラッパーを前提とした worktree 運用と相性が良い。

## 起動例

```
/integrate-worktree migrate-page-comment
/integrate-worktree page-bookmark
/integrate-worktree feat-something
```

引数は **worktree の identifier** (= `gw start` で作った時の名前 or branch 名)。

## 前提

- main に直接コミットする運用 (feature branch 経由で PR を作らない)。
- worktree は `gw` ラッパーで作成・削除する (`git worktree` 直接コマンドは使わない)。
- ローカルのみで完結 (push / PR は明示指示があるまで行わない)。
- 並行 worktree が他にも存在する可能性があるので、main への merge 後はそれらが追従して
  rebase する想定。

## ワークフロー

```
worktree 作業確認 → main へ merge → conflict 解消 → 自動チェック
  → dev/watch 停止 → gw end → tmux window close → simplify → stale spec/task 掃除
```

### Step 1: worktree の作業内容を確認

```bash
# 対象 worktree のパスを特定
WORKTREE_PATH=$(git worktree list | awk -v name="$IDENTIFIER" '$0 ~ name {print $1}' | head -1)

# 作業ツリーが clean か (uncommitted があれば中止)
cd "$WORKTREE_PATH" && git status --short

# main から先行している commit を確認
git log --oneline main..HEAD

# 触ったファイル一覧
git diff --name-only main..HEAD
```

`git status --short` に出力があれば **中止**。worktree 側で commit していない変更は
ユーザー判断が必要。

### Step 2: merge 前の状態確認

main 側の作業ツリーが clean か確認:

```bash
cd <main worktree>
git status
```

clean でなければ中止。merge は dirty な main では行わない。

### Step 3: merge

`--no-ff --no-commit` で衝突を確認:

```bash
git merge <branch> --no-ff --no-commit
```

衝突あり → Step 3.1 へ。なし → Step 3.2 へ。

#### Step 3.1: 衝突解消

```bash
git status --short  # AA / UU 行が衝突
```

各衝突ファイルについて:
- 内容を読み、両側の変更を理解する
- どちらを採るか判断する。判断材料の例:
  - shadcn など外部ライブラリのバージョンに合わせる
  - 後発の方が情報量が多い側を優先する
  - 機能差がある場合は両方の意図を尊重して手動マージ
- 解消後 `git add <file>` でステージ

判断が難しい場合はユーザーに確認 (auto mode でも、設計判断はあえて止まる)。

#### Step 3.2: ノイズ除外

worktree 側で生成された **作業メモ系のファイル** (例: `.reviews/`, `.tmp/`) が staging に
含まれていたら main 履歴に残さない方が良い。`.gitignore` に追加して unstage する:

```bash
git rm --cached <noise file>
# .gitignore に追加してこの merge commit に含める
```

判断基準:
- 実装コード / テスト / docs → コミットに含める
- review メモ / 作業ログ / 一時ファイル → 除外して `.gitignore` に追加

### Step 4: 自動チェック

merge commit を作る前に、統合後のビルド / 型 / テスト / lint が通るか確認:

```bash
pnpm --filter @crowi/api-contract build  # contract 編集を含む場合
pnpm --filter @crowi/api type-check
pnpm --filter @crowi/web type-check
pnpm --filter @crowi/api test
pnpm lint                                 # errors=0 必須
```

1 つでも失敗したら中止。conflict 解消の判断ミスや、両側の変更の組み合わせで型が合わなく
なっているケースが多い。

`pnpm lint` の error が出る場合は merge を `--abort` して原因切り分け。worktree 側のコード
が新しい lint ルールに引っかかるケースは、**worktree 側で先に直してから** 再 merge する
(主問題側の責任)。`pnpm lint` warnings は許容するが、merge commit のメッセージ末尾に
"Note: <warnings 件数> warnings remain (existing)." として記録するのが望ましい。

### Step 5: merge commit 作成

メッセージは標準的な merge commit 形式 + 衝突解消の要点:

```
Merge branch '<branch>' into main

<取り込んだ機能の 1-2 行サマリ>

Conflict resolution:
- <file>: <採用した側 + 理由>

(必要なら) Also: <gitignore 追加など merge と同時にやった整備>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### Step 5.5: worktree の dev/watch プロセスを停止 (gw end の前に必須)

`gw end` は内部で `git worktree remove`(`--force` なし)を実行する。このとき
worktree の `pnpm dev` スタック — 特に **`next dev --turbopack`**(`.next/dev/cache/turbopack/`
へ常時書き込む)・`tsx watch`・`turbo`・`esbuild` — がホスト側で生きていると、git の
再帰削除と書き込みが競合し、最後の `rmdir` が **`Directory not empty` (ENOTEMPTY)** で失敗する。
結果、git は worktree を **deregister するのに物理ディレクトリだけ残す**(`gw end` が exit 255 で
失敗し、`crowi-<name>/` が孤児として残る)。`docker compose down` はコンテナを止めるだけで
これらホストプロセスは止めないため、**削除前に明示的に止める**。

```bash
WT="${WORKTREE_PATH%/}"   # Step 1 で特定済み
# bundler/watcher 系のみを対象 (素の node = Claude/MCP/editor は Step 6.5 に任せる)。
# 各 PID の cwd が worktree 配下にあることを確認してから止めるので、他 worktree は触らない。
for pid in $(pgrep -f 'next|tsx|turbo|esbuild|vitest|jest|nodemon|hocuspocus' 2>/dev/null); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  case "${cwd:+$cwd/}" in "$WT"/*) echo "stop dev proc $pid ($cwd)"; kill "$pid" 2>/dev/null ;; esac
done
sleep 1   # SIGTERM が効くのを待つ
```

このロジックは `gw` の `pre_end_hook`(`~/.gw/hooks/docker-compose-down.sh`)にも保険として
入っているが、フック未導入の環境でも安全に閉じられるよう skill 側でも先に止める。tmux で
`pnpm dev` を別 pane に出している場合は、Step 6.5 の window kill が先に効けばそちらでも止まる
(が、Step 6.5 は `gw end` の **後**なので、この Step 5.5 がレース回避の本命)。

### Step 6: worktree close

`gw` ラッパーで worktree を削除し、merge 済みブランチを削除:

```bash
gw end <identifier>
git branch -d <branch>  # 安全削除 (-D は使わない、merge 済みなら -d で OK)
```

`gw end` が branch 削除まで含む場合もあるので、`gw end --help` で確認してから手順を決める。
ローカル環境によって挙動が変わるので、`git branch -d` が「already deleted」エラーを
返したら無視。

### Step 6.5: 該当 tmux window を閉じる (任意)

`gw end` で worktree path 自体は消えるが、対応する tmux window は残る。同じ worktree
で作業していた pane (Claude session、vim、mongosh 等) はもう不要なので、安全に
閉じられるなら閉じる。

#### 判定ロジック

worktree path を `pane_current_path` に持つ全 pane を一覧:

```bash
WORKTREE_PATH=<実 path>
tmux list-panes -a -F '#{window_id}|#{pane_id}|#{pane_current_path}|#{pane_current_command}|#{pane_title}' \
  | awk -F'|' -v p="$WORKTREE_PATH" '$3 ~ "^"p"(/|$)"'
```

各 pane を以下のルールで分類:

- **(a) 通常 process**: `pane_current_command` が `zsh` / `bash` / `vim` / `make` /
  `mongosh` / `node` 等 → ユーザーの作業道具。**そのまま kill 候補**。
- **(b) Claude session 作業中**: `pane_current_command` が `2.x.x` 形式 (Claude Code バージョン)
  かつ pane title 先頭が **`⠐⠴⠼⠦` などのブレイル文字** (進行中スピナー) →
  **kill しない、Step 6.5 全体を中止**。
- **(c) Claude session アイドル**: `2.x.x` かつ title 先頭が **`✳` (アスタリスク)** →
  プロンプト待ちで安全に kill 可能。**そのまま kill 候補**。

`pane_current_command` が `2.x.x` の判定は実用的な heuristic。Claude Code のバージョン
文字列が常に `<major>.<minor>.<patch>` で始まる前提に依存するので、将来検出が壊れたら
title 文字 (`✳` vs ブレイル) のみで判定するように退避してよい。

#### 実行

全 pane が (a) または (c) だけなら window 単位で kill:

```bash
tmux list-panes -a -F '#{window_id}|#{pane_current_path}' \
  | awk -F'|' -v p="$WORKTREE_PATH" '$2 ~ "^"p"(/|$)" {print $1}' \
  | sort -u \
  | while read win; do
      tmux kill-window -t "$win"
    done
```

(b) が 1 つでもあれば中止し、ユーザーに「window <id> で Claude session が作業中。
手動で確認してから閉じてください」と報告して Step 7 に進む。

#### 想定外時の振る舞い

- そもそも `tmux list-panes -a` が空 / `TMUX` 変数が無い → tmux 環境ではない、Step 6.5 を
  完全にスキップ
- 該当 pane が 1 つも見つからない → 既にユーザーが手動で閉じている、スキップ
- `tmux kill-window` が失敗 → 警告のみ、Step 7 に進む

### Step 7: simplify で統合後のコードを最適化

merge 直後は、両側の変更が混ざってコードに重複や非効率が生まれていることがある。
`simplify` skill を呼んで統合差分をレビューする:

```
simplify <description of merged work>
```

simplify が見つけた issue は直接修正し、別 commit (例: `refactor(merge): ...`) としてコミット。
修正がなければ skip。

### Step 8: stale な spec / task ファイルを掃除 (提案 → 削除)

merge が完了したので、対応する `.feature-state/specs/<id>.md` と
`.feature-state/tasks/<id>.json` は **役目を終えている**。放置すると `.feature-state/`
にゴミが溜まり、orchestrate の groom / 着手 ready 判定が雑音まみれになる。
**該当ファイルを `git rm` で削除する**。

#### 削除候補の特定

整合性 (`<id>` 一致) を担保するため、`<identifier>` から **両方の prefix 変種**を見る:

- `<identifier>` 単体 (例: `revision-revert`, `ci-automation`)
- `feature-<identifier>` (例: `feature-revision-revert`, `feature-ci-release-automation`)

実際にどちらの prefix で spec / task が置かれているかは作業ごとに違う (どちらも
歴史的に使われている)。`ls .feature-state/{specs,tasks}/ | grep -E '<identifier>'`
で実在するものだけ拾う。

```bash
SPEC=$(ls .feature-state/specs/*.md 2>/dev/null | grep -E "(^|/)(feature-)?${IDENTIFIER}\\.md$" || true)
TASK=$(ls .feature-state/tasks/*.json 2>/dev/null | grep -E "(^|/)(feature-)?${IDENTIFIER}\\.json$" || true)
```

#### 検証 (削除前のセーフガード)

- task ファイルの `status` が `COMMITTED` または `INTEGRATED` 相当か確認
  (まだ `IN_PROGRESS` / `REVIEW` / `NEEDS_WORK` のままなら誤判定の可能性 →
  削除せず報告)。
- 同名 worktree が **既に消滅**しているか (`git worktree list` に出ない)。
- spec が **他の spec から `depends-on:` で参照**されていないか
  (`grep -lR "<basename>" .feature-state/specs/` で確認)。参照あり → 削除せず
  報告し、orchestrate B の stale 候補として温存。

すべて OK なら削除に進む。1 つでも崩れたら **削除せず**、その理由を「skip:
<理由>」として記録し、Step 9 へ。

#### 実行 (commit なし)

`.feature-state/` は **gitignore 配下** (`/.feature-state/`) なので git には乗らない。
普通の `rm` で消すだけで、commit は不要 / 不可。

```bash
rm -f <spec> <task>
```

実行後にどのファイルを消したかを1行で報告する (例:
「dropped `.feature-state/tasks/<id>.json`」)。spec が無いケースは task のみ、
逆も同様。

> なぜ merge commit に同梱しないか: そもそも gitignore 配下なので同梱できない。
> 同期エージェント (orchestrate B) は次 tick で `ls .feature-state/specs/` の
> 結果から自然に消えた事実を読み取れるので、状態は track 外で十分。

#### 想定外時

- 該当する spec / task が **そもそも存在しない** (worktree が spec を切らずに直接
  実装されたケース、あるいは crowi-complete-feature が synthesize した task のみ
  あった場合) → 黙ってスキップ。
- `rm` が失敗 (permission 等) → 削除せず警告のみ、Step 9 へ進む。

## 失敗ハンドリング

- **conflict 解消後に type-check / test が失敗**: merge を `git merge --abort` で巻き戻し、
  原因を分析。worktree 側に欠けている依存があるなら worktree 側で先に rebase してもらう
  (= ユーザー or 他エージェントに差し戻し)。
- **`gw end` が refuse する**: worktree が dirty / lock 状態の可能性。`gw end --help` を
  読んで適切なフラグを使う。`-f` (force) は最終手段でユーザー確認。
- **merge 後に先行コミットがあると気づいた**: revert ではなく `git reset --hard` で merge
  前に戻す (ローカルだけで未 push 前提なら安全)。push 済みなら revert を提案してユーザー
  確認。

## 範囲外

- worktree の **作成** (`gw start`) はこの skill の対象外
- main を origin に push する操作 (常にユーザー指示待ち)
- 複数 worktree の連続マージ (1 回の起動で 1 worktree)

## 補足: なぜ skill 化するか

並行 worktree 運用では「終わった branch を main に取り込む」操作が頻発する。標準の git
コマンドだけだと:
- 衝突解消の判断
- ノイズファイルの除外
- 統合後の品質チェック
- worktree close + branch 削除
- simplify による整理
- `.feature-state/{specs,tasks}/` の stale ファイル掃除

を毎回手作業で漏れなくこなす必要がある。skill としてまとめておけば、操作が再現可能で、
判断の漏れも減らせる。
