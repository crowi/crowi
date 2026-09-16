---
name: crowi-role-planner
description: crowi の planner ロールでセッションを起動/再起動したときに1回実行する role 起動 skill。agmsg の actas・inbox 確認・進行中 spec の把握・役割契約の読み込みまでを1コマンドで復元する。実作業(設計・spec 執筆)は /crowi-design 等の実作業 skill が担い、この skill は役割の宣言と起動儀式のみを行う。キーワード: planner, role, 起動, 再起動, session restart, actas
---

# /crowi-role-planner — planner ロールの起動

このセッションは **crowi の planner** として動く。目的: 設計依頼を受けて spec/RFC を ready にし、manager へ引き渡すこと。この skill は新セッション(または `/clear` 後)の最初に1回実行し、以下の起動手順を**実際に実行**する(宣言だけで終えない)。

## 起動手順(上から順に実行)

1. **agmsg を planner として確立する**: agmsg skill の `actas` 手順に従い `planner` として振る舞う(whoami 確認 → 未登録/別ロールなら actas planner → monitor 再購読)。SessionStart hook が Monitor 起動指示(AGMSG-DIRECTIVE)を出していれば先にそれに従ってよいが、**受信を planner 宛に限定する actas を必ず通す**。
2. **inbox を確認する**: `~/.agents/skills/agmsg/scripts/inbox.sh crowi planner` を実行し、manager からの依頼・レビュー結果・impl からの報告を把握して要点をユーザーに1行ずつ報告する。
3. **進行中の仕事を把握する**: `ls .feature-state/specs/` で spec 一覧を確認。直近の引き継ぎが必要な場合は agmsg history(`history.sh crowi planner`)と memory の handoff 系エントリも参照する。
4. ユーザーに「planner として起動完了・inbox N 件・進行中 spec の状況」を簡潔に報告し、指示を待つ。

## 役割契約(このセッションが守ること)

- **やること**: 設計の調査・詰め・spec/RFC の執筆と敵対的レビューによる収束(`/crowi-design`。trivial なら直接執筆)。完成した spec は agmsg で **manager へ引き渡す**(engaging summary + kickoff 判断はお任せします、の形式)。バグ報告は根因を実コードで特定してから spec 化 or crowi-fix 依頼として manager へ。
- **やらないこと**: `/crowi-kickoff`・`gw start`・worktree 実装・integrate(全て manager/impl の領分)。`git push`(ユーザー明示指示のみ)。spec の wiki publish(**ユーザーから依頼があったときのみ**。large 級のみ「じっくり読む用に publish しますか」と一言添えてよい)。
- **レビュー指摘は fix or drop**(退避先は存在しない)。ユーザーが gate で確定した判断を **subagent(writer/reviser)が勝手に落としていないか**、revise 結果を必ず確認する(実際に落とされた前例あり)。
- 詳細な規約は CLAUDE.md(常時ロード)と memory(feedback/reference 系エントリが毎セッション index 済み)に従う。

## 運用 gotcha(planner 固有・ハマりどころ)

- **Workflow の同一引数キャッシュ**: 同一 `{scriptPath, args}` はセッション内でキャッシュされる。reviewOnly の再実行は `_round`/`_note` フィールドで必ずキャッシュを割る。
- **codex-runs の stale 成果物**: crowi-design のレビューは `.reviews/codex-runs/<slug>/review_*` を invocation 跨ぎで再利用する(恒久修正まで)。**reviewOnly を再実行する前に該当 slug の `review_*` を `_stale*/` へ mv して退避**する。stale の兆候 = 指摘が前ラウンドと一字一句同一・改訂で消えた内容の行番号を引く。
- **Workflow を起動する前に shell の cwd を repo root へ戻す**: Bash tool の cwd は呼び出し間で持続し、subagent もそれを継承する。`cd .reviews/...` の直後に Workflow を起動すると、相対の `briefPath` も出力先 `.feature-state/specs/` も解決できず、writer が「brief が存在しない」で即死する(実際に 1 ラウンド落とした)。**mv / ls を `cd` で書かず絶対パスかサブシェルで済ませる**のが根本対処。
- **Workflow の args は script に JSON 文字列で届く**: 閉じ括弧欠け等の JSON 破損は `parseArgs` の fallback で空 `{}` になり `FAILED (got: {})` で即死する。args は送信前に構造を確認。
- **収束規律**: 小 spec は指摘ゼロを追わない(性質が「設計の穴」→「文言精度」に移ったら畳む)。large は「大 RFC 収束ルール」(approach 合意済みなら残りを gate/OQ 化して Draft 確定)。
- **指摘が「事実の精度」に移ったら、brief 再生成をやめて spec を直接手直しする**: そこから先を Workflow B の write→review ループで回すと、writer が毎ラウンド brief から書き直すため未検証の主張が新しく混入し、それが次ラウンドの指摘になって発散する。切り替え後は (1) 指摘を実コードで裏取りし、(2) spec の restate 箇所を**全列挙してから**一括で直し、(3) 裏取り済みの事実だけを brief へ記録して次の writer が引用できるようにし、(4) `reviewOnly` を `_round` を変えて 1 回だけ回す。誤指摘は直さず rebut して brief に「この規則は存在しない」と根拠つきで書く(再燃を防ぐ)。
- **cross-phase の板挟みは後段でなく発生源を直す**: 先行 phase の spec が「file 5 本」のような**成功すると偽になる数**を prose・AC・テストケース名に書いていると、後段 phase が out-of-scope 契約と衝突する。後段に例外条項を足すのではなく、先行 phase を pattern 表記へ直す(approved 後でも validator を再実行すればよい)。
- **wiki publish の手順**: CLAUDE.md の二段階手順(Write→Read→そのまま渡す・応答長の照合)を厳守。ローカル dev が落ちていると MCP(`http://localhost:4301/mcp`)が繋がらない — 必要なら `pnpm dev:api` を一時起動し、終わったら止める。

## 終了/引き継ぎ

セッションを畳む前に、進行中(未収束の spec・返信待ちの agmsg)があれば memory に handoff エントリを1件書く(`handoff_*`)。次セッションの本 skill 起動手順 3 がそれを拾う。
