---
name: crowi-handoff
description: |
  セッションを終える・中断する・引き継ぐときに、作業状態を定型 HANDOFF ドキュメント +
  memory ポインタ + agmsg 通知として残す。worktree / main どちらでも動く。
  完了済みの worktree では handoff ではなく /crowi-complete-feature を先に促す。
  キーワード: handoff, 引き継ぎ, 中断, セッション終了, 退避, 後で続き
---

# Crowi Handoff (セッション終了・中断・引き継ぎの標準化)

作業を途中で止めるとき・別セッションに引き継ぐときの手順を定型化する skill。
これまでアドホックに書いていた HANDOFF メモ + memory 追記を統一し、開発ループの
**出口の取りこぼし**(signal 立て忘れ = 統合負債)を塞ぐ。

## 起動例

```
/crowi-handoff              # 現在のセッションの作業を引き継ぎ可能な状態にする
```

## ワークフロー

### Step 1: 状態収集(read-only)

```bash
git rev-parse --abbrev-ref HEAD          # branch(main か worktree か)
git status --porcelain                    # dirty か
git log main..HEAD --oneline             # worktree 時: 積んだ commit
cat .feature-state/tasks/<id>.json       # あれば status(id は worktree dir 名から解決 — complete-feature と同じ規則)
```

会話コンテキストから「何をしていたか / どこまで**検証済み**か」を集める。

### Step 2: 完了判定 → complete-feature 優先

worktree で、かつ以下が全部成り立つなら「**handoff ではなく `/crowi-complete-feature`
を先に実行すべき**」と判断し、その場で実行(Skill 経由):

- 作業ツリー clean ∧ `main..HEAD` 非空 ∧ 会話上で作業完了と認識している

- ゲートが **green** → signal が立つ。handoff は「統合待ち」の 1 行記録に縮退して Step 6 へ。
- ゲートが**落ちた** → 通常の handoff に戻り、**落ちた内容を HANDOFF の「未完」に必ず書く**。

> handoff は complete の代替ではない — この分岐が統合負債(signal 立て忘れで
> orchestrate から不可視になる worktree)への直接の対策。

### Step 3: HANDOFF ドキュメント生成

置き場所:

- **worktree セッション** → worktree root に `HANDOFF-<id>.md`(**commit しない**。
  未統合の間は worktree と共に生存し、統合後は不要になる。integrate-worktree の
  ノイズ除外対象)。
- **main セッション** → `.feature-state/HANDOFF-<YYYY-MM-DD>-<topic>.md`(gitignore 配下)。

テンプレ:

```markdown
# HANDOFF — <id or topic> (<YYYY-MM-DD>)

## 目的 / スコープ
<1-3 行>

## 現在地(事実ベース)
- branch: <branch> @ <sha> / main..HEAD: <N> commits / working tree: clean|dirty(<件数>)
- gates: type-check <✅/❌/未実行> / test <…> / lint <…>(最後に走らせた時刻)
- 検証済みのこと / **未検証のこと**(「たぶん動く」は未検証に分類)

## 完了済み
- <sha> <subject>

## 未完・残タスク
- <具体的に。「テスト追加」ではなく「X の異常系テスト(Y のケース)が無い」>

## 次の一手(コマンドレベル)
1. <cd どこで何を打つか>

## 罠・gotcha
- <ハマりどころ。無ければ「なし」>

## 検証コマンド
<この HANDOFF の主張を再確認できるコマンド列>
```

### Step 4: memory ポインタ

- **main プロジェクトの memory dir** に `handoff_<id>.md` を書く(frontmatter
  `type: project` + 要点 5 行以内 + HANDOFF ファイルへのポインタ)。`MEMORY.md` に
  1 行追記(既存 handoff メモリ群と同形式)。
- **memory dir の導出**: worktree セッションは自分の memory dir が worktree パス由来に
  なるため、main worktree のパス(`git worktree list` の先頭)から
  `~/.claude/projects/<絶対パスの / を - に置換>/memory/` を導出して書く。
- dir が存在しなければ **skip して報告**(HANDOFF ファイル + agmsg が代替。エラーにしない)。

### Step 5: agmsg 通知(任意)

`~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code` で team crowi に
join 済みか確認 → 済みなら:

```bash
~/.agents/skills/agmsg/scripts/send.sh crowi <own> manager \
  "<id> を中断/引き継ぎ。HANDOFF: <path>。要点: <1 行>"
```

manager 不在・未 join・スクリプト不在は skip(報告に明記)。

### Step 6: 報告

HANDOFF path / memory 書けたか / 通知したか /(Step 2 で complete した場合)
signal が立った旨、を簡潔に。

## 鉄則

- **push しない** / **勝手に commit しない**(dirty はそのまま記録する)
- HANDOFF は**事実ベース**: 検証済みと未検証を必ず区別する
- 完了済みなら handoff より complete-feature(Step 2 の分岐を飛ばさない)

## エッジケース

| ケース | 挙動 |
|---|---|
| main セッションで作業対象が曖昧 | 会話の主題を topic にする(複数あれば主要 1 つ + 残りは箇条書き) |
| memory dir が無い / 書けない | skip + 報告(エラーで止まらない) |
| agmsg 不在 | skip + 報告 |
| complete-feature が gate 落ち | handoff 続行。落ちた gate を「未完」の先頭に書く |
