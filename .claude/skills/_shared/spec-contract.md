# implementation-ready spec contract v2

`crowi-design spec` が実装セッションへ渡す spec の共通契約。`crowi-design` / `crowi-kickoff` / `crowi-feature` / `crowi-orchestrate` はこのファイルを正本として参照し、独自の ready 条件を増やさない。

目的は、実装時にアーキテクチャ・配置・契約・テスト観点を再発見させず、安価な実装モデルが対象コードを読んですぐ編集へ入れる状態を作ること。spec に production code 全文は書かない。正確な型・関数シグネチャ、難しい分岐の擬似コード、イベント列は書いてよい。

## frontmatter

```yaml
---
id: feature-<slug>
name: <human-readable name>
scope: trivial | small | medium | large
spec_contract: 2
status: draft | approved
implementation_ready: false | true
grounded_at: <git commit SHA>
---
```

- writer は `status: draft` / `implementation_ready: false` で作る。
- 敵対的レビューが APPROVED になったら finalizer が一時的に
  `status: approved` / `implementation_ready: true` へ変更して validator を実行する。
  green ならその marker を確定し、red なら必ず `draft` / `false` へ戻す。
- `grounded_at` はコード調査の基準にした `git rev-parse HEAD`。参照 path がこの commit 以後に変わった場合、spec は stale。
- **生成物は staleness 判定から除外される**(`pnpm-lock.yaml` / `**/openapi.{json,yaml}` / `**/generated/**`)。この判定は「spec が根拠にしたコードが動いた」を検出するためのもので、再生成された lockfile や OpenAPI は誰かが build を回しただけであり、設計の前提は何も無効になっていないため。除外はパスで機械的に決まるので、spec 側の宣言は要らず既存 spec にも遡及する。ただし**そもそも生成物を参照先に書かない**のが望ましい(AC が生成物の同期を要求したいなら、参照先はゲート対象のソースにして `Level` を `gate` にする)。

## umbrella spec (`kind: umbrella`)

複数フェーズを 1 worktree で順に実装し、main への統合を最後に 1 回だけ行う大型作業では、運用契約とフェーズ表だけを持つ **umbrella** を置き、実装の実体は各フェーズの sub-spec に持たせる。umbrella 自身は AC も実装マップも `grounded_at` も持たない — それらを sub-spec から複製すると、複製した側が独立に stale になるため。

```yaml
---
spec_contract: 2
kind: umbrella
id: feature-<slug>
status: approved
phases:
  - feature-<slug>-phase0-<...>
  - feature-<slug>-phase1-<...>
---
```

- validator は umbrella に対して AC / 実装マップ / セクション / `grounded_at` を要求しない。代わりに **`phases:` の各 sub-spec が実在し、それ自体が v2 を通ること**を検証する。厳しさは緩めずに sub-spec へ委譲する形。
- **`phases:` は frontmatter のブロックシーケンスで書く**(散文のフェーズ表は人間向けの説明として残してよいが、機械が読むのは frontmatter)。表を parse する方式にすると、書式を変えた瞬間に「フェーズ 0 本を検証して pass」という偽の green が出る。
- umbrella の入れ子は不可(sub-spec は実装 spec でなければならない)。
- `scope` は大きさ(trivial/small/medium/large)を表すので umbrella をそこに載せない。

## 必須セクション

ドキュメント言語が日本語なら左、英語なら括弧内の見出しを使う。

1. `## 背景 / why` (`## Background / why`)
2. `## やること (ユーザー視点)` (`## User-visible behavior`)
3. `## やらないこと (out of scope)` (`## Out of scope`)
4. `## 設計の主な判断` (`## Key design decisions`)
5. `## 実装マップ (implementation map)` (`## Implementation map`)
6. `## 処理・データフロー (control / data flow)` (`## Control / data flow`)
7. `## 契約・不変条件 (contracts / invariants)` (`## Contracts / invariants`)
8. `## 受け入れ基準 (acceptance criteria)` (`## Acceptance criteria`)
9. `## テスト計画 (test plan)` (`## Test plan`)
10. `## 実装順序 (implementation order)` (`## Implementation order`)
11. `## 未確定事項 (open questions)` (`## Open questions`)

## 実装マップ

変更対象ごとに次の形で書く。path は repo-relative。既存 symbol の変更だけでなく、新設する symbol も名前を確定する。

```markdown
### Change: `src/export/export.ts`

- status: existing
- symbols: `exportRows`, `ExportOptions`
- changes: `exportRows` の一括取得を cursor ベースの逐次出力へ変える。公開引数は維持する。
- reuse: `src/export/cursor.ts#iterateCursor`
```

新規ファイルでも `status: new`、予定 symbol、責務、reuse 先を書く。再利用対象が無い場合は `reuse: none — <理由>` とする。

- `status: existing` の path と symbol は現在のリポジトリに実在しなければならない。
- `status: new` の path はまだ存在していてはならない。
- `reuse` に書く既存 path / symbol も実在しなければならない。
- `Change`、`reuse`、テスト計画の Test file はすべて freshness の監視対象になる。

## 処理・データフロー

正常系だけでなく、失敗時・並行時を含む実行順を番号付きで書く。イベント駆動や race がある場合は、どの state を誰がいつ読み書きするかまで書く。

**条件付き更新 / CAS を書くなら、その条件が何と一致を見るのかまで決める。** 「CAS する」「条件付きで消す」と動作だけ書いて照合対象を決めないと、実装者に残る道は「対象の中身を比較する」しかない。**内容ベースの identity は厳しくしても収束しない** — MongoDB なら native driver でスキーマ外のフィールドを注入できるので、比較対象は「writer が宣言していない形」まで際限なく広がり、レビューのたびに一致条件を狭めるパッチが積まれる。**不透明な id を 1 つ持たせて問いごと消す**。フィンガープリント一致への切り替えは「何をフィンガープリントに含めるか」という新しい終わらない問いに置き換わるだけである。

書けたかどうかは「**この条件は何と一致するか**」を 1 文で言えるかで判定する。言えないなら identity が設計されていない。

## 契約・不変条件

少なくとも以下を、該当しない場合も `n/a — <理由>`（英語では `n/a - <reason>` も可）
の形で明示する。

- 公開型・関数・API request/response
- Authentication/authorization
- Validation
- Error semantics
- Transaction/concurrency
- Backward compatibility / migration
- Performance/resource limit

**運用者・利用者に出す出力にも契約を書く。** レポート・ログ・エラーメッセージに「何を載せてよいか」を決める。とくに driver / ORM の検証エラー本文は違反した値をそのまま埋め込むので、`err.message` を持ち回すと秘密値が運用者ログへ流出する。フィールド名は残してよいが値は伏せる、のように明示する。

**性能契約を書いたら、自分が書いた AC と同時に満たせるかを検算する。** 「この操作でクエリを増やさない」と「この応答フィールドは常に実際の状態を反映する」を両方書くと、実装が追い込まれて片方を破ることがある。とくに**応答に新しいフィールドを足す spec で、そのフィールドの取得を条件付きにしない** — 条件付きにするなら、フィールドを optional にするか AC を弱めるかを同時に決める。新しいクエリを足すときは、**要らなくなった既存クエリを探して差し引く**と両立できることが多い。

## 受け入れ基準とテスト計画

AC には stable ID を付ける。

```markdown
- [ ] AC-1: 10万件を複数バッチでストリーミング出力できる。
```

テスト計画は各 AC を最低1行へ対応づける。

```markdown
| AC | Test file | Case | Level |
|---|---|---|---|
| AC-1 | `src/export/export.test.ts` | 10万件を複数バッチで出力する | integration |
```

各行の Test file / Case / Level は空欄にしない。Test file は repo-relative path にする(新設予定なら spec 作成時点で未存在でもよい)。

正常系・異常系・認証認可のうち該当するケースを列挙する。プロジェクト固有の critical-flow 表がある場合は e2e 対象もここで確定する。

## 実装順序

依存順に、編集・生成物更新・migration・docs・test・gate を並べる。multi-phase の場合は既存の `### Phase N: <title> (即時 / 非衝突)` / `(要調整)` marker を使い、各 phase 内に実装マップ・AC・テスト計画を対応づける。

## 未確定事項

実装をブロックする未決を残さない。

- 未決なし: `- なし` / `- none`
- 既定で進められる問い: `- <question> → 既定: <answer>` / `- <question> — default: <answer>`

箇条書きでない prose や、既定値のない問いが1行でも残っていれば blocking とする。

## 検証

repo root で実行する。

```bash
bash ".claude/skills/_shared/validate-implementation-spec.sh" <spec-path>
```

green でなければ `crowi-kickoff` へ渡さない。legacy spec は `crowi-feature` の planner fallback で実装できるが、`crowi-kickoff` の implementation-ready 経路には入れない。
