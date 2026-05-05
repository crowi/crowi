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
worktree 作業確認 → main へ merge → conflict 解消 → 自動チェック → close → simplify
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

merge commit を作る前に、統合後のビルド / 型 / テストが通るか確認:

```bash
pnpm --filter @crowi/api-contract build  # contract 編集を含む場合
pnpm --filter @crowi/api type-check
pnpm --filter @crowi/web type-check
pnpm --filter @crowi/api test
```

1 つでも失敗したら中止。conflict 解消の判断ミスや、両側の変更の組み合わせで型が合わなく
なっているケースが多い。

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

### Step 6: worktree close

`gw` ラッパーで worktree を削除し、merge 済みブランチを削除:

```bash
gw end <identifier>
git branch -d <branch>  # 安全削除 (-D は使わない、merge 済みなら -d で OK)
```

`gw end` が branch 削除まで含む場合もあるので、`gw end --help` で確認してから手順を決める。
ローカル環境によって挙動が変わるので、`git branch -d` が「already deleted」エラーを
返したら無視。

### Step 7: simplify で統合後のコードを最適化

merge 直後は、両側の変更が混ざってコードに重複や非効率が生まれていることがある。
`simplify` skill を呼んで統合差分をレビューする:

```
simplify <description of merged work>
```

simplify が見つけた issue は直接修正し、別 commit (例: `refactor(merge): ...`) としてコミット。
修正がなければ skip。

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

を毎回手作業で漏れなくこなす必要がある。skill としてまとめておけば、操作が再現可能で、
判断の漏れも減らせる。
