---
name: crowi-design
description: |
  設計アイデアを RFC か spec に落とすワークフロー。新機能 / 記法 / アーキの設計を
  「調査 → 設計 → 敵対的レビュー → ドキュメント化」で詰めたいとき。重い調査・設計・
  レビュー・執筆を subagent (Workflow) に散らして main を軽く保ち、ユーザーとの収束だけ
  対話ゲートに残す。crowi-feature (実装) の設計版。
  キーワード: 設計, design, rfc, spec, 設計レビュー, 調査, ドキュメント化, brainstorm, 設計判断, 壁打ち
globs:
  - "docs/rfcs/**"
  - ".feature-state/specs/**"
  - ".feature-state/design/**"
---

# Crowi Design Skill (調査 → 設計 → 設計レビュー → ドキュメント化)

設計アイデアを **RFC**(大きな設計判断・OSS 資産・commit する / 英語)か
**spec**(コードレベルの判断まで完了した実装指示書・commit しない / 日本語)に落とすワークフロー。
spec は `.claude/skills/_shared/spec-contract.md` の implementation-ready contract v2 に従い、
実装時にアーキテクチャ・配置・契約・テスト観点を再発見させない。
重い調査・設計・レビュー・執筆を **subagent に散らして main を軽く** 保つのが目的。
実装は `crowi-feature`、その **設計版** がこれ。

## いつ使う

- 新機能 / 記法 / アーキの設計を、調査から詰めて RFC か spec にしたいとき。
- 「設計を詰めたい」「RFC 書きたい」「spec 切りたい」「これ設計レビューして」。
- **使わない**: 1 ショットで書ける trivial な spec(直接書けばよい)、すでに実装が
  始まっている(→ `/code-review`)、既存 spec の単体検証だけ(→ `/crowi-spec-review`)。

## 核心: 2 Workflow + 対話ゲート

設計の収束(案の選択・RFC/spec 判断・open question の解決)は **ユーザーとの対話**で、
Workflow には追い出せない(背景実行は途中で `AskUserQuestion` を出せない)。だから
crowi-feature と同じく **人間ゲートを Workflow の外** に置く。

```
/crowi-design <topic>
  └ Workflow A (explore-frame): 調査 ×3 並列 → 設計案 + RFC/spec 判定 → brief 保存 + サマリ返却
  ── GATE (main + AskUserQuestion): 案 / 出力種別 / open Q を確定 ──
  └ Workflow B (review-document): 執筆 → 敵対的レビュー(spec ×4 / RFC ×3) → 是正ループ → ready 確定
  → main: doc + verdict + 次の一手を報告
```

main が保持するのは **brief サマリ + ゲート + 最終報告** だけ(生の調査ログ・コード読み・
執筆は subagent 側に留まる)。

## stage アサイン(Workflow 内・コードで固定)

分析・批評・長文執筆は **Codex**(`codex exec`)が主担当。各 Codex ステージは
**thin glue agent(haiku/low)** が `.claude/scripts/codex-run.sh` 経由で駆動する
ので、Claude 消費はほぼゼロ。Codex 不可時は **fail-open で従来の Claude 実装に
自動 fallback** する(spec: feature-codex-role-split)。

各 Codex ステージは `codex-run.sh --tier` で **semantic なモデル tier**(sol=最難 /
terra=一般 / luna=単純)を選ぶ。実 model id(`gpt-5.6-{sol,terra,luna}`)と tier 既定
effort(sol=high / terra=medium / luna=low)は wrapper に 1 箇所だけ持つ。

| stage | 主担当 | tier | fallback(fail-open) |
|---|---|---|---|
| 調査: codebase + prior decisions | **Codex**(read-only・1 run) | terra | Explore sonnet ×2 |
| 調査: prior art(web 調査) | Explore sonnet | —(Claude) | —(Claude 固定) |
| 設計案(architect・brief 執筆) | **Codex**(workspace-write) | **sol** | general-purpose(session / high) |
| **収束(ゲート)** | **main**(session) | — | — |
| 執筆 RFC | **Codex**(workspace-write) | **sol** | general-purpose(session) |
| 執筆 spec(選択案のコードレベル詳細化) | **Codex**(workspace-write) | **sol** | general-purpose(session / high) |
| 設計レビュー(spec ×4 / RFC ×3、並列) | **Codex**(read-only) | terra →(最終 attempt)**sol** | general-purpose(session / high) |
| Claude lens(critical 時のみ +1) | general-purpose(session / high) | — | — |
| 是正(revise) | **Codex** | terra | general-purpose |
| spec ready 確定 | haiku/low(機械的 validator 実行) | — | — |

**レビューのエスカレーション**: 設計レビューは早期ラウンドは terra、APPROVED/NEEDS_WORK を
分ける**最終 attempt(`attempt === maxReviewAttempts`)だけ sol** に上げる — terra が弾き
続ける doc に一度だけ最強判定を当てる(毎ラウンド sol を焚かない)。

### critical フラグ(Claude lens の追加基準)

topic / spec が **データ消失・認証認可・並行 race・migration・crypto** に絡むなら、
main が Workflow B の args に `critical: true` を立てる。critical 時は通常の Codex lens 群に
**Claude lens(red-team 系)が 1 本追加**される — Codex の盲点を単一障害点にしない
ための保険。通常時は Claude lens ゼロ。

### fallback の報告義務

Workflow の返り値 `codexFallbacks[]` に fallback 発動が記録される。**最終報告には
「stage X は Claude fallback で実行(理由)」を必ず明記**する(黙って Claude で
走らせない)。

## 起動フロー(skill = main がやること)

1. **slug を決める**: topic から **英語 kebab slug**(RFC/spec のファイル名規約に合わせる。
   例 `image-display-attributes`)。`/crowi-design rfc|spec <topic>` なら `outputHint` を
   その種別に固定、無ければ `auto`。
2. **Workflow A を起動**(同じ turn 内で必ず発火):
   ```
   Workflow({ scriptPath: '.claude/skills/crowi-design/explore-frame.workflow.js',
              args: { slug, topic, outputHint } })
   ```
   返り値 = FRAME(`approaches` / `recommendedOutput` / `openQuestions` / `briefPath` / `scope`)。
   `status: 'FAILED'` なら reason を提示して止める。
3. **ゲート**: `approaches` を簡潔に提示し、`AskUserQuestion` で確定する(推奨を先頭・末尾に
   「(推奨)」)。最大 4 問なので優先順に:
   - どの案で進めるか(options = approaches の name)
   - RFC か spec か(`outputHint` が指定済みならこの問いは省略。default = `recommendedOutput`)
   - 主要な open question(残り枠で。各 option に architect の recommendation を先頭表示)
   - 答えきれない open question は **「open のまま」** として持ち越す(doc に明記される)。
4. **Workflow B を起動**:
   ```
   Workflow({ scriptPath: '.claude/skills/crowi-design/review-document.workflow.js',
              args: { slug, title, outputType, briefPath, scope,
                      decisions: { approach, answers }, maxReviewAttempts: 2,
                      critical: <bool> } })   // critical フラグの基準は上記
   ```
   **`decisions` の組み立て方** — ここの作り方が、Workflow B が何ラウンドかかるかをほぼ決める:
   - **先頭は「これは何であるか」**。作るものの positive な形を 1 項目目に置く。禁止から始めない。
   - **禁止事項を単調に増やさない。** 差し戻しのたびに禁止を足していくと、writer の失敗は「勝手に作る」から
     「作らない・許さない」へ反転する (実例: 禁止 19 項目・positive 記述ゼロの指示で、writer が対象機能の
     本体そのものを拒否する spec を書いた)。**同じ禁止を 2 回書きたくなったら、それが含意する positive な
     1 文に置き換える。**
   - **brief を節番号で名指しする。** 機構は brief に既に書かれていることが多い。再導出させず
     「brief §53 のとおり実装せよ」と書く。指示は writer にとって brief より上位の権威なので、
     長い禁止リストは brief を実質的に押し流す。
   - **実コードで裏を取った事実は「確認済み・再調査不要」と明示して渡す。** 前ラウンドの調査成果 (行番号つき)
     を捨てさせない。
   - 項目数が 15 を超えたら、それ自体が「leaf が大きすぎる」か「禁止で positive を代用している」のサイン。

   spec の writer は、ゲートで選ばれた案だけを対象にコードを再度ピンポイントで読み、
   `.claude/skills/_shared/spec-contract.md` の path/symbol 単位の実装マップ、処理フロー、
   契約・不変条件、AC→test 対応、実装順序まで確定する。production code 全文は書かない。
   レビュー中は `status: draft` / `implementation_ready: false`。全 lens APPROVED 後、
   finalizer が provisional に `status: approved` / `implementation_ready: true` へ変更して
   `.claude/skills/_shared/validate-implementation-spec.sh` を実行し、green なら確定、
   red なら draft/false へ戻す。

   返り値 = `{ status, docPath, verdict, residualOpenQuestions, rebutted?, blocking?, preexisting?, findings?, reviewStats?, reviewSummary, codexFallbacks }`。`rebutted[]` は「レビュー指摘自体が誤りだったので実コード反証つきで適用しなかった」もの — 最終報告に載せる。`findings[]` / `preexisting[]` / `reviewStats` の意味は reviewOnly(§reviewOnly 節)と同じ。
5. **報告**(`status` で分岐):
   - **DONE**(verdict APPROVED)→ doc を提示:
     - **spec** → `.feature-state/specs/feature-<slug>.md`(敵対的レビュー済み)。
       次の一手: **`/crowi-feature feature-<slug>`** で実装へ(または `/crowi-kickoff`)。
       あわせて **「wiki に publish するか」を確認**(一文で可)。publish する場合:
       `crowi_get_page` で `/crowi/spec/feature-<slug>` の存在を確認 → 無ければ
       `crowi_create_page`(body = spec 全文そのまま)、有れば revision_id を取って
       `crowi_update_page`(楽観ロック。409 は再取得して 1 回リトライ)。
       **CLAUDE.md「Wiki page writes」の二段階手順(Write→Read→そのまま渡す。
       body をその場で組み立てない)を必ず守る**。
       MCP 未接続のセッションでは「wiki publish は skip(MCP 未接続)」と報告するだけで
       よい(エラーにしない)。**RFC は publish 対象外**(正本は repo の docs/rfcs/ commit)。
     - **RFC** → `docs/rfcs/00NN-<slug>.md`(**未 commit**)。ユーザーにレビューを依頼し、
       OK をもらったら **`docs(rfc): add RFC-00NN ...` を main 直 commit**(push しない)。
       実装パス: RFC → spec(`/crowi-design spec ...`)→ `/crowi-feature`。
   - **NEEDS_WORK** → 残った `blocking` を提示し、人間の設計判断を仰ぐ(doc は残す。
     方針が定まったら `/crowi-design review <docPath>` で再レビュー、または手で是正)。
     **大 RFC の収束ルール**: approach が合意済みなら、残 blocking を実装 gate +
     open question に落として **Draft として確定してよい**(指摘ゼロまでレビューループを
     回さない — 大 RFC は long tail になる)。是正必須なのは fundamental な誤りと
     自分の混入誤りのみ。
   - **FAILED** → reason を提示。
   - **DEGRADED** → この round は独立した codex 判定をほぼ経ていない(`reviewStats` で内訳が見える)ので verdict として採用しない。doc 自体はディスクに残っている(`status: draft` / `implementation_ready: false`)。**単純な再実行は割高** — write-review-revise loop に resume 入口は無いので、再度 Workflow を呼ぶと writer が brief から書き直しになり、それまでの revise round で積んだ修正が失われる。実務上の対処は codex 復旧を待ってから再実行するか、`acceptFallback: true` を args に足して明示的に縮退した判定を受け入れる(spec を approved に上げる根拠にはしない)。
   - いずれの分岐でも `codexFallbacks` が非空なら「stage X は Claude fallback で実行」を
     報告に含める。

> skill 側で守るのは 1 つだけ: **§2 と §4 の Workflow 起動を実際に発火** すること
> (「あとは自動で進みます」と予告して Workflow を呼ばずに turn を締めない)。
> Workflow を呼ぶのは「skill の指示で呼ぶ」= 正当な opt-in(勝手な多エージェント化ではない)。
> **Workflow 起動後に `ScheduleWakeup` / heartbeat を張らない** — ハーネスが追跡する
> background task なので完了時に自動再起動される(保険の wakeup は不要かつ、非 /loop
> では prompt 無しで `prompt is required when stop is not true` エラーになる。crowi-feature
> SKILL.md の同注記参照)。

## サブコマンド

```
/crowi-design <topic>          # 全自動: A → ゲート → B
/crowi-design rfc <topic>      # 出力を RFC に固定(ゲートの種別問いを省略)
/crowi-design spec <topic>     # 出力を spec に固定
/crowi-design explore <topic>  # Workflow A だけ(brief + 案を提示して止まる)
/crowi-design review <path>    # 既存 doc に敵対的レビューだけ(Workflow B を reviewOnly で)
```

`/crowi-design review <path>`:
```
Workflow({ scriptPath: '.claude/skills/crowi-design/review-document.workflow.js',
           args: { slug, outputType, reviewOnly: true, docPath: <path>,
                   critical: <bool>, round: <毎回変える値> } })
```

返り値には `blocking[]` に加えて構造化 `findings[]`(`{lens, category, text}` の
dedup 済み)、round を跨いで蓄積された `preexisting[]`、`reviewStats`(lens の
実行内訳)が載る。**`status: 'DEGRADED'` は「この round は独立した codex 判定を
ほぼ経ていない」の意味で、OK/ISSUES の代わりに返る** — verdict として採用せず、
codex 復旧後の再実行か `acceptFallback: true` での明示受け入れを選ぶ。

**同じ doc を再レビューするときは `args` に必ず区別できる値(`round` 等)を入れる。**
Workflow は同一 `{scriptPath, args}` をセッション全体でキャッシュするので、doc を直して
から同じ引数で呼び直すと、**編集前のレビュー結果がそのまま返る**(指摘の行番号が現行 doc と
合わない、既に直した内容を未修正として指摘する、という形で現れる)。`args` が違えば
キャッシュは効かない。
(spec の単体検証は `/crowi-spec-review` が人間入口 — そちらは本質的に
correctness-critical 用なので `critical: true` 固定で本 Workflow を呼ぶ。)

## crowi-spec-review / crowi-feature との関係

- Workflow B のレビュー段は、**spec 向けに `crowi-spec-review` の 3 観点・実コード裏取りの
  敵対的レンズ**(根本原因再検証 / 修正の red-team / 網羅+アーキ)に
  **implementation-ready contract 検証 lens**を加え、**RFC 向けに設計批評
  パネル**(代替案の十分性 / 網羅性・セキュリティ / OSS 品質)を使う。
  `crowi-spec-review` スキルは「既存 spec の単体検証」の人間入口として残す。
- 出力(spec)は **`.claude/skills/_shared/spec-contract.md` の implementation-ready contract v2**
  に従う。frontmatter の `spec_contract: 2` / `grounded_at`、path+symbol 単位の実装マップ、
  契約・不変条件、stable AC→test 対応を持つので、`/crowi-feature feature-<slug>` で
  設計をやり直さず実装に入れる。

## state

- 中間 brief: `.feature-state/design/<slug>.brief.md`(gitignore 済みスクラッチ。
  architect が書き、Workflow B の writer が読む)。
- spec 出力: `.feature-state/specs/feature-<slug>.md`(非 commit)。
- RFC 出力: `docs/rfcs/00NN-<slug>.md`(レビュー後に commit)。

**wiki との正本ルール**(crowi-kickoff と共通):
1. 作業中の正本は `.feature-state/specs/`(gitignore・エージェントが読む・完了時に削除)。
2. wiki `/crowi/spec/<id>` は**耐久スナップショット**(セッション横断・複数マシン・実装後も残る)。
3. 同期は一方向のみ: design → wiki(publish)/ wiki → specs/(kickoff の pull)。
   双方向同期・差分マージはしない。両方に存在して食い違ったら `.feature-state/specs/` が勝つ。

## 重要な前提

- **パイプライン本体は 2 つの Workflow スクリプト**(この skill ディレクトリ)。制御フロー・
  model アサイン・レビューループはコードに集約され、「予告して turn を締める」失敗は起きない。
- **main 直コミット運用**(RFC のみ・レビュー後)。`git push` は明示指示まで行わない。
- crowi commit に `Co-Authored-By` trailer は付けない。
- **この skill は Claude(Workflow ランタイム)専用**。Codex は `codex-run.sh` 経由で
  「ステージとして呼ばれる側」(research digest / architect / RFC writer / reviewer)。
  Codex セッションでこの skill を直接実行しようとしない。
