---
name: crowi-spec-review
description: |
  spec を実装に渡す前に「本当に正しいか」を敵対的に検証したい時。特に correctness critical
  (データ整合性 / 並行 / 認証 / セキュリティ / 消失リスク) な spec、または「この spec で大丈夫?
  ちゃんとチェックして」と言われた時。根本原因が実コードと合っているか・修正案が十分か・
  抜けが無いかを、独立した複数観点で実コードに当てて確認する。
  キーワード: spec review, spec 検証, 大丈夫か, ちゃんとチェック, red-team, 根本原因, 設計レビュー, データ消失, 裏取り, adversarial
globs:
  - ".feature-state/specs/**"
---

# Crowi Spec Review (敵対的・実コード裏取りの spec 検証)

## 核心原則

**spec は、それを書いた本人(= あなた)が鵜呑みにすると診断を外す。** 独立した複数観点で
**実コードに当てて**検証し、**結論で spec を是正する**。コメントを返すだけでは終わらない。

> 実績: editor-preview-reliability spec は「desync したクライアント Y.Doc が空 save で本文消失」を
> 中核に据えていたが、3観点レビューが実コード(Hocuspocus 内部 + yjs 実測)で**中核診断の誤り**
> (save はサーバ doc を読む / save 前に必ず seed 済み / CRDT 上空クライアントは消せない)を捕捉し、
> 真の経路(楽観ロック欠如 + yjsState 空上書き)へ是正できた。鵜呑みレビューなら通過していた。

## いつ使う

- **実装(`/crowi-feature`)前**に、correctness critical な spec を検証したい(データ消失 / 並行 /
  認証 / セキュリティ / トランザクション境界 / 移行)。
- ユーザーが「**この spec で大丈夫? ちゃんとチェックして**」と言った。
- spec の根本原因 / 修正の十分性に自信が持てない。
- **使わない**: trivial/small で機械的な spec、すでに実装が始まっている(その場合は `/code-review`)。

## 非交渉の3ルール(これを外すと検証にならない)

1. **実コード裏取り必須** — spec の各主張を「成立 / 過大 / 誤り」で判定し、**file:line を引く**。
   spec の言い分・記憶・推測で確定しない。必要なら依存ライブラリの実装 (`node_modules`) や実測まで。
2. **独立レンズ** — レビューは並列・互いにブラインドの**異なるレンズ**で走らせる(同じ観点を
   複数回ではなく、根本原因 / 修正の red-team / 網羅+アーキ)。redundancy では拾えない失敗を拾う。
   レンズの定義・実行は **`review-document.workflow.js` が正本**(下記)— prose に複製しない。
3. **結論で spec を是正** — 出力はコメント集ではない。**是正済み spec**(改訂注記を残さず、最初から
   そう書かれていたかのようにクリーンに書き直す。誤り→是正の二重記載は実装者を混乱させる)か、
   問題なければ「検証済み」と明示。是正内容の説明は spec ではなく会話側で返す。
   ユーザーには verdict(OK / 要是正 + 何を)を一言で返す。

## 手順(薄い入口 — レビュー本体は crowi-design Workflow B)

この skill は入口で、レビューの実行系は **crowi-design の reviewOnly Workflow** に集約
されている(レンズは Codex ×3 + Claude ×1。Codex 不可時は各レンズが Claude に fail-open)。

1. spec(`.feature-state/specs/<id>.md`)を読み、scope と criticality(消失/並行/認証 が
   絡むか)を掴む。これは main がやる。
2. **reviewOnly Workflow を起動**。spec-review は本質的に correctness-critical 用途なので
   **`critical: true` 固定**(= Codex 3 レンズ + Claude red-team レンズ 1 本):
   ```
   Workflow({ scriptPath: '.claude/skills/crowi-design/review-document.workflow.js',
              args: { reviewOnly: true, docPath: '.feature-state/specs/<id>.md',
                      outputType: 'spec', slug: '<id>', critical: true } })
   ```
   返り値 = `{ status: 'OK'|'ISSUES', blocking[], reviewSummary, codexFallbacks }`。
3. **統合(レビューのレビュー)**: blocking を main が判断する。レビュアーは過大主張も
   するので、**怪しい指摘は自分で実コードに当てて再確認**してから採用する。
4. **是正**: 採用した blocking を反映して spec を**クリーンに書き直す**(改訂注記・
   before/after は spec に残さない。「何を・なぜ」是正したかは会話側の報告で返す。
   書き直しは sonnet subagent に任せてよい — spec writer の方針と同じ)。問題なければ
   status に「検証済み」を足す。ユーザーへ verdict を報告し、`codexFallbacks` が非空なら
   「レンズ X は Claude fallback で実行」も明記する。

## 観点(定義の正本は `review-document.workflow.js` の spec 用 lenses)

| レンズ | 担当 | 仕事 |
|---|---|---|
| root-cause | Codex | spec の各根本原因主張を実コードで confirm/refute。誤診断を暴く。 |
| red-team | Codex | 提案 fix をすり抜けてバグ/消失が残る経路を、並行・stale・race・認証境界の具体イベント列で探す。 |
| coverage | Codex | 抜けた failure mode 列挙 + アーキ妥当性 + 過剰スコープ指摘。 |
| claude-red-team | Claude | critical=true の追加レンズ。Codex の盲点を単一障害点にしないための保険。 |

## よくある失敗

- **rubber-stamp**(「読んだ感じ良さそう」で通す)→ 誤診断を見逃す。実コードに当てるまで OK と言わない。
- **観点が独立していない**(同じ問いを3回)→ redundancy では拾えない。レンズを変える。
- **file:line を引かない**→ 主張が検証されていない。根拠を必須に。
- **コードでなく prose をレビュー**→ spec の文章だけ読んで満足。実装・依存・実測まで。
- **コメントで終える**→ 是正された spec を残さない。結論は「直した spec」か明示の verdict。
- **レビュアーを鵜呑み**→ レビュアーも過大主張する。怪しい指摘は自分で再確認(レビューのレビュー)。
- **fallback を黙る**→ どのレンズが Claude fallback で走ったかを報告に書かないと、
  cross-model 検証が効いていたかをユーザーが判断できない。

## crowi-feature との関係

correctness critical な spec は、**`crowi-spec-review` で是正 → `/crowi-feature` で実装**の順。
spec が正しくなければ planner/implementer は正しい間違いを丁寧に作る。レビューは**実装前**に効く。
