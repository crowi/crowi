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
**spec**(実装可能な小タスク指示書・commit しない / 日本語)に落とすワークフロー。
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
  └ Workflow B (review-document): 執筆 → 敵対的レビュー ×3 → 是正ループ → doc + verdict 返却
  → main: doc + verdict + 次の一手を報告
```

main が保持するのは **brief サマリ + ゲート + 最終報告** だけ(生の調査ログ・コード読み・
執筆は subagent 側に留まる)。

## stage アサイン(Workflow 内・コードで固定)

分析・批評・長文執筆は **Codex**(`codex exec`)が主担当。各 Codex ステージは
**thin glue agent(haiku/low)** が `.claude/scripts/codex-run.sh` 経由で駆動する
ので、Claude 消費はほぼゼロ。Codex 不可時は **fail-open で従来の Claude 実装に
自動 fallback** する(spec: feature-codex-role-split)。

| stage | 主担当 | fallback(fail-open) |
|---|---|---|
| 調査: codebase + prior decisions | **Codex**(read-only・1 run) | Explore sonnet ×2 |
| 調査: prior art(web 調査) | Explore sonnet | —(Claude 固定) |
| 設計案(architect・brief 執筆) | **Codex**(workspace-write) | general-purpose(session / high) |
| **収束(ゲート)** | **main**(session) | — |
| 執筆 RFC | **Codex**(workspace-write) | general-purpose(session) |
| 執筆 spec | general-purpose sonnet | —(Claude 固定・当面) |
| 設計レビュー ×3(並列) | **Codex** ×3(read-only) | general-purpose(session / high) |
| Claude lens(critical 時のみ +1) | general-purpose(session / high) | — |
| 是正(revise) | RFC=**Codex** / spec=sonnet | general-purpose |

### critical フラグ(Claude lens の追加基準)

topic / spec が **データ消失・認証認可・並行 race・migration・crypto** に絡むなら、
main が Workflow B の args に `critical: true` を立てる。critical 時は Codex 3 lens に
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
   返り値 = `{ status, docPath, verdict, residualOpenQuestions, rebutted?, blocking?,
   reviewSummary, codexFallbacks }`。`rebutted[]` は「レビュー指摘自体が誤りだったので
   実コード反証つきで適用しなかった」もの — 最終報告に載せる。
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
   - いずれの分岐でも `codexFallbacks` が非空なら「stage X は Claude fallback で実行」を
     報告に含める。

> skill 側で守るのは 1 つだけ: **§2 と §4 の Workflow 起動を実際に発火** すること
> (「あとは自動で進みます」と予告して Workflow を呼ばずに turn を締めない)。
> Workflow を呼ぶのは「skill の指示で呼ぶ」= 正当な opt-in(勝手な多エージェント化ではない)。

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
                   critical: <bool> } })
```
(spec の単体検証は `/crowi-spec-review` が人間入口 — そちらは本質的に
correctness-critical 用なので `critical: true` 固定で本 Workflow を呼ぶ。)

## crowi-spec-review / crowi-feature との関係

- Workflow B のレビュー段は、**spec 向けに `crowi-spec-review` の 3 観点・実コード裏取りの
  敵対的レンズ**(根本原因再検証 / 修正の red-team / 網羅+アーキ)を、**RFC 向けに設計批評
  パネル**(代替案の十分性 / 網羅性・セキュリティ / OSS 品質)を使う。
  `crowi-spec-review` スキルは「既存 spec の単体検証」の人間入口として残す。
- 出力(spec)は **`crowi-feature` の spec スキーマ**(frontmatter `id`/`name`/`scope` +
  規定セクション)に従うので、`/crowi-feature feature-<slug>` で直接実装に入れる。

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
