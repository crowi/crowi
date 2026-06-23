---
name: crowi-feature
description: |
  Crowi 2.0 の新機能開発ワークフロー。設計合意 (会話で詰めた spec) を起点に、
  spec 承認 → Workflow (plan → implement → simplify → review-loop → commit) を決定的に駆動。
  制御フローは pipeline.workflow.js (コード)、各 phase は feature-* エージェント。
  キーワード: feature, 新機能, 開発, build, 設計, spec, workflow
globs:
  - "packages/api/src/hono/handlers/**"
  - "packages/web/src/app/**"
  - "packages/api-contract/src/**"
---

# Crowi 2.0 Feature Skill

新規機能をゼロから追加するためのワークフロー。
旧実装互換が前提の `crowi-migration` と並列の skill。**設計を会話で詰めた後** に
起動して自動進行させるのが想定パターン。

## 想定ユースケース

- 新規 API エンドポイントの追加 (旧実装が無い)
- 新しい admin 画面 / ユーザー画面の追加
- 既存機能への大きめの拡張 (旧実装と挙動が変わる)
- ライブラリ・ツール導入を伴う機能

旧 Express/Swig コードからの移植は `crowi-migration` を使う。

## ワークフロー全体像

```
   ↓ 会話で設計を詰める (壁打ち)
   ↓ ユーザー: 「これで実装!」
   ↓
/feature {name}
   ↓
[spec phase] ← 唯一の人間ゲート (spec.md 承認)
   ↓
[skill] config 読込 + scope→needsPlanner 判定 + multi-phase 抽出 → args 組立
   ↓
[Workflow: pipeline.workflow.js] ← 制御フローはコード (予告して止まる失敗が起きない)
   for each phase:
     planner? → implementer → simplify? → reviewer ─┬(APPROVED)→ committer
                    ↑                                │
                    └────── NEEDS_WORK (最大 N 回) ──┘
   autoContinue=false の phase 手前で GATED 返却 → 人間に resume を促す
   ↓
[skill] Workflow の status (DONE / GATED / ESCALATE / FAILED) で報告
```

各 phase の責務:

- **planner**: spec を読み、コードベースを grep して再利用候補 (hooks / components / utils / 既存契約) を context に充填、AC を spec から起こす。**利用者/運用者に見える変化なら、影響する `apps/crowi-site/` ドキュメントを特定して `context.docsTargets` に充填する** (→「crowi-site ドキュメント更新」節)
- **implementer**: 実装 + テスト + **crowi-site ドキュメント更新 (ja/en)**、必須チェック (type-check / test / lint / format) を全部走らせる、commitPlan を埋める
- **simplify**: `simplify` skill を呼び、reuse / quality / efficiency を整える
- **reviewer**: AC 達成 / 契約整合 / セキュリティ / トランザクション境界を確認。**docsTargets がある場合はドキュメント反映の有無も確認**
- **committer**: task.commitPlan に従って **複数 commit** を作る (feat 本体 / test / docs 分割。crowi-site の更新は `docs(site)` commit に分ける)

## state 管理

ディレクトリ: **`.feature-state/` (リポジトリ root)** ※ `.claude/feature-state/` ではない
gitignore 済み (`.gitkeep` のみ tracked)。

```
.feature-state/
├── config.json             # 静的 config（SHARED, read-mostly）
├── specs/
│   └── {id}.md            # 設計仕様（SHARED, per-id）
├── tasks/
│   └── {id}.json          # planner が埋めた context + AC + commitPlan + status（SHARED, per-id）
└── queue.json              # currentTask 等（PER-WORKTREE, volatile）※共有しない
```

#### 共有 / per-worktree の線引き（並列 worktree 安全性）

`gw` worktree は `~/.gw/hooks/feature-state-link.sh` で **`specs/` `tasks/`
`config.json` だけ** を MAIN worktree に symlink 共有する。**`queue.json` は
worktree ローカル**（共有しない）。理由:

- `specs/` `tasks/` は **per-id ファイル**。並列 worktree は別々の id を触るので
  共有して安全（むしろ「ある worktree で起こした spec を全 worktree から見たい」）。
- `config.json` は静的（実行時に書き換えない）read-only なので共有して安全。
- `queue.json` の `currentTask` は **「この worktree が今やっているタスク」= 単一
  ポインタ**。これを共有すると、並列 `/feature` 実行が互いの `currentTask` を
  上書きして壊れる。だから per-worktree に分離する。

> 1 worktree = 1 タスク（= 1 `tasks/{id}.json`）。`currentTask` はその worktree
> ローカルの「今のタスク」。タスク一覧が欲しければ `ls tasks/` を見る（集約
> しない）。`tasks/{id}.json` への書き込みは torn write を避けるため
> tmp+rename で atomic に行う。

### config.json スキーマ（SHARED, 静的）

```json
{
  "commitStrategy": "main-direct",
  "maxReviewAttempts": 3,
  "runSimplify": true,
  "minScopeSize": "small"
}
```

### queue.json スキーマ（PER-WORKTREE, volatile）

```json
{
  "currentTask": "feature-attachment-thumbnail",
  "lastUpdated": "2026-05-09T...",
  "lastCompletedTask": "feature-..."
}
```

`minScopeSize`（config.json）: `trivial | small | medium | large`
spec の `scope:` がこの閾値より大きい (`>`) ときだけ planner が起動する。
デフォルト `small` (= medium 以上で planner、small / trivial は skip)。
順序は `trivial < small < medium < large`。

### spec.md スキーマ

```markdown
---
id: feature-attachment-thumbnail
name: 添付画像のサムネイル生成
scope: medium
---

## 背景 / why
...

## やること (ユーザー視点)
...

## やらないこと (out of scope)
...

## 設計の主な判断
- どこに置くか (API / Web / 共通)
- 依存ライブラリの追加可否
- DB スキーマ変更の有無
- パフォーマンス / セキュリティ上の制約

## 受け入れ基準 (acceptance criteria)
- [ ] ...
- [ ] ...

## 未確定事項 (open questions)
- ...
```

`scope` の目安:
- **trivial**: 1 ファイル / 50 行未満 / 既存 helper 流用 / テスト不要レベル
- **small**: 1〜2 ファイル + テスト / 既存契約を拡張するだけ
- **medium**: 新契約 + API + UI / 複数 commit / 数百行
- **large**: 新モデル or 新 schema or 外部サービス連携。**planner で task 分割を強く検討**

### Multi-phase spec の扱い

spec 中に `### Phase N: <title>` ヘッダが **2 本以上** あれば、その spec は **multi-phase**
として扱う。1 spec = 1 task は変えないが、task.json に `phases[]` を持たせて phase 単位で
plan→impl→simplify→review→commit のサイクルを回し、commit ごとに次の phase に進む。

phase の `autoContinue` フラグはヘッダの末尾マーカーから自動判定する:

- ヘッダに **「(即時 / 非衝突)」「(no conflict)」** などの marker → `autoContinue: true`
- ヘッダに **「(要調整)」「(needs coordination)」「(blocked by …)」** などの marker → `autoContinue: false`
- どちらでもない → `autoContinue: true` をデフォルト (== 通常はノンストップ)

`autoContinue: false` な phase に到達したら **その phase の commit 直前** で停止し、ユーザーに
「Phase N は要調整。続けるなら `/feature feature-xxx --phase=N` を起動」と報告する。
`autoContinue: true` な phase は commit 後そのまま次の phase の plan に進む。

phase 完了 = その phase に紐付くすべての commit が landed。spec の `## 受け入れ基準` を
phase ごとに分けて書いてある場合、reviewer は **その phase の AC のみ** をチェックする。

### task ファイルスキーマ (`tasks/{id}.json`)

```json
{
  "id": "feature-attachment-thumbnail",
  "name": "添付画像のサムネイル生成",
  "status": "PLANNED",
  "scope": "medium",
  "context": {
    "specPath": ".feature-state/specs/feature-attachment-thumbnail.md",
    "reuseTargets": [
      "packages/api/src/util/fileUploader.ts (driver 抽象を再利用)",
      "packages/web/src/components/page-view/AttachmentList.tsx (一覧 UI に組み込み)"
    ],
    "newFiles": [
      "packages/api/src/util/thumbnail.ts (sharp ラッパー)",
      "packages/api-contract/src/contracts/attachment-thumbnail.ts (新契約)"
    ],
    "models": ["packages/api/src/models/attachment.ts (thumbnail フィールド追加)"],
    "newDeps": ["sharp (画像処理)"],
    "architecturalNotes": "Storage driver 経由で生成・保存。同期処理 (アップロード時にブロック)。",
    "docsTargets": {
      "assessment": "user-visible",
      "entries": [
        {
          "ja": "apps/crowi-site/content/docs/ja/guide/attachments.mdx",
          "en": "apps/crowi-site/content/docs/en/guide/attachments.mdx",
          "action": "edit",
          "metaUpdate": false,
          "summary": "サムネイル生成と表示の節を追記"
        }
      ]
    }
  },
  "acceptanceCriteria": [
    "画像添付時に 320x320 サムネが生成され S3/local 両方で取得できる",
    "非画像 (PDF 等) はサムネ生成をスキップする",
    "失敗してもアップロード自体は成功する"
  ],
  "openQuestions": ["sharp のメモリ上限"],
  "commitPlan": [
    {
      "type": "feat",
      "scope": "api",
      "title": "implement attachment thumbnail generation",
      "files": ["packages/api/src/util/thumbnail.ts", "..."]
    },
    {
      "type": "test",
      "scope": "api",
      "title": "cover thumbnail generation edge cases",
      "files": ["packages/api/src/util/thumbnail.test.ts"]
    },
    {
      "type": "docs",
      "scope": "site",
      "title": "document attachment thumbnails",
      "files": [
        "apps/crowi-site/content/docs/ja/guide/attachments.mdx",
        "apps/crowi-site/content/docs/en/guide/attachments.mdx"
      ]
    },
    {
      "type": "docs",
      "scope": "todo",
      "title": "mark attachment thumbnail done",
      "files": ["TODO.md"]
    }
  ],
  "history": [
    {"phase": "planner", "at": "ISO8601", "summary": "計画完了"}
  ]
}
```

#### Multi-phase 版の task スキーマ

multi-phase spec の場合、`commitPlan` の代わりに `phases[]` を持つ:

```json
{
  "id": "feature-monorepo-packages-restructure",
  "name": "モノレポ packages の publish 構成大改修",
  "status": "PLANNED",
  "scope": "large",
  "currentPhase": "phase-1",
  "phases": [
    {
      "id": "phase-1",
      "title": "workspace: プロトコル徹底",
      "specSectionAnchor": "### Phase 1: workspace: プロトコル徹底 (即時 / 非衝突)",
      "status": "PLANNED",
      "autoContinue": true,
      "commitPlan": [
        {"type": "refactor", "scope": "deps", "title": "switch all internal deps to workspace:^", "files": ["..."]}
      ],
      "commitShas": []
    },
    {
      "id": "phase-2",
      "title": "peerDependencies 明文化",
      "specSectionAnchor": "### Phase 2: peerDependencies 明文化 (即時 / 非衝突)",
      "status": "PLANNED",
      "autoContinue": true,
      "commitPlan": [...],
      "commitShas": []
    },
    {
      "id": "phase-5",
      "title": "apps/crowi-api → packages/api 移動",
      "specSectionAnchor": "### Phase 5: apps/crowi-api → packages/api 移動 (要調整 / 並行 worktree と衝突可能性あり)",
      "status": "PLANNED",
      "autoContinue": false,
      "commitPlan": [...],
      "commitShas": []
    }
  ],
  "context": { ... },
  "history": [
    {"phase": "planner", "at": "ISO8601", "summary": "9 phases 抽出。Phase 1-4 を autoContinue=true、5-9 を false で初期化"}
  ]
}
```

phase ごとの status:`PLANNED → IN_PROGRESS → REVIEW → (APPROVED → COMMITTED) | NEEDS_WORK`。
全 phase が COMMITTED になったら task 全体の `status = COMMITTED`、`queue.currentTask = null`。

## 起動フロー (skill 内手順)

`/feature {name}` が呼ばれたら以下を実行:

### 1. spec の準備

```
1.1. .feature-state/specs/{name}.md の有無を確認
1.2. あれば: そのまま使う (人間レビュー済みとみなして次へ)
1.3. なければ:
     - 直近会話を読み、spec の各セクションを埋めて .feature-state/specs/{name}.md を書き出す
     - scope は会話内容と編集規模見込みから自動判定
     - 「以下の spec で進めますか?」とユーザーに提示し、承認を待つ
     - ユーザーから修正指示があれば反映、再提示
1.4. spec.md の scope を読み取る
```

### 2. 実行 — Workflow で決定的に駆動

spec 承認の後は **`Workflow` ツール (`pipeline.workflow.js`) が plan→implement→simplify→
review-loop→commit を駆動する**。順次起動・NEEDS_WORK リトライ・multi-phase 反復・
autoContinue gate はすべて JS コードなので、モデルが「次に進めます」と予告して turn を
止める失敗モードは構造的に起きない。各 phase は既存の feature-{planner,implementer,
reviewer,committer} エージェントを `agentType` でそのまま再利用する。

skill がやること (= Workflow の外側、人間ゲートを持つ層):

```
2.1. config.json を読む: minScopeSize (既定 small) / maxReviewAttempts (既定 3) / runSimplify
2.2. needsPlanner を決める: spec.scope > minScopeSize なら true
     (順序 trivial<small<medium<large)
2.3. multi-phase 判定: spec に `### Phase N:` が 2 本以上あれば phases[] を抽出。
     各 phase の autoContinue を末尾マーカーから判定 ((即時/非衝突)→true、
     (要調整)/(blocked)→false、無印→true)。task.json に phases[] を書く。
     single-phase なら phases=[{id:'main', title:<name>, autoContinue:true}]。
     `--phase=N` 指定時は phases を N 以降に絞る。
2.4. Workflow を起動 (同じ turn 内で必ず発火):
     Workflow({ scriptPath: '.claude/skills/crowi-feature/pipeline.workflow.js',
                args: { id, needsPlanner, runSimplify, maxReviewAttempts, phases } })
2.5. Workflow の返り値 status で分岐 (これだけが skill の判断材料):
     - DONE      → 完了報告 (step 4)
     - GATED     → 「Phase <gatedAt> は要調整。続けるなら `/feature {id} --phase=<gatedAt>`」
     - ESCALATE  → reason を提示して指示を仰ぐ (設計判断 / 曖昧さ / max NEEDS_WORK 超過)
     - FAILED    → reason を提示 (必須チェック失敗 / commitPlan⇄diff 不整合 等)
```

> Workflow は背景実行で**末尾に返る**ため、途中で人間入力を待てない。だから人間ゲート
> (spec 承認・gated phase・escalate) は **Workflow の外 (この skill / 会話)** で扱う —
> これが「autoContinue 区間ごとに 1 Workflow、gate で人間に返す」設計の理由。
> 中断後は `Workflow({scriptPath, resumeFromRunId})` で未変更 prefix をキャッシュ再利用して再開できる。
> Workflow を呼ぶのは「skill の指示で呼ぶ」= 正当な opt-in 経路 (勝手な多エージェント化ではない)。

#### 制御フローは Workflow が担保する (旧「連続実行ルール」は不要に)

順次起動・NEEDS_WORK ループ・multi-phase 反復・autoContinue gate の制御は
`pipeline.workflow.js` の **コード**が司る。旧版にあった「各 phase 出口で次を必ず起動」
「予告で turn を締めるの禁止」「magic string ハンドシェイク禁止」「言い回しチェックリスト」
といった**プロンプトでの制御フロー強制は不要になった** — コードは予告して止まらないため。

- reviewer の APPROVED / NEEDS_WORK / ESCALATE は `schema` 構造化返却で、Workflow が
  分岐・ループする (文字列の解釈に依存しない)。
- 停止 (人間に返す) はすべて Workflow の return に集約され、status で表現される:
  - **ESCALATE**: NEEDS_WORK が maxReviewAttempts 連続 / implementer が「必須チェックを通せない・
    spec が曖昧」と判断 / reviewer が設計判断を要求。
  - **GATED**: 次 phase が `autoContinue:false` (gated phase の手前)。
  - **FAILED**: committer で commitPlan⇄diff が解消不能。
- skill 側で守るのは 1 つだけ: **§2.4 の Workflow 起動を、spec 承認と同じ turn で実際に発火**
  すること (「あとは自動で進みます」と予告して Workflow を呼ばずに turn を締めない)。
  起動後は Workflow が完了 status を返すまで進み、skill はその status を受けて報告する。

### 4. 完了

`task.status = COMMITTED`、`queue.currentTask = null`。
committer は実装完了済み spec (`.feature-state/specs/{id}.md`) を **削除する**
(残 phase / 残タスクが無く task 全体が COMMITTED のときだけ。multi-phase で未完 phase
が残る / PARTIALLY_COMMITTED のときは保持)。詳細は feature-committer の「spec の後始末」。
push / PR 作成は **明示指示があるまで行わない**。

## ステータス遷移

task / phase の status (`PLANNED → IN_PROGRESS → REVIEW → APPROVED → COMMITTED | NEEDS_WORK`)
は **agent がファイルに書く永続記録**。pipeline 進行中の制御 (今どの phase / 何回目の review か)
は **Workflow スクリプトの変数**が持つので、旧版のように skill が status の ping-pong を turn
跨ぎで追う必要はない。`tasks/{id}.json` の status は (a) 最終結果の記録、(b) orchestrate の
`READY_TO_INTEGRATE` 等の**プロセス間 signal**、のために残す。

## サブコマンド (個別 phase 起動)

```
/feature {name}                # 全自動: spec 承認 → Workflow を最後まで (会話前提)
/feature {name} --phase=N      # multi-phase spec の Phase N から resume (gated phase 通過用)
/feature plan {name}           # planner エージェントだけ (Workflow を介さず単発)
/feature implement {id}        # implementer エージェントだけ (NEEDS_WORK / IN_PROGRESS のとき)
/feature review {id}           # reviewer エージェントだけ (REVIEW のとき)
/feature commit {id}           # committer エージェントだけ (APPROVED のとき)
```

`--phase=N` は task.json の `phases[]` を **N 以降に絞って** Workflow の `args.phases` に渡す。
Workflow は N から走り、次の `autoContinue:false` phase の手前で GATED 返却するので、N から
最後まで autoContinue が連続していれば一気に進む。個別サブコマンド (`plan`/`implement`/`review`/
`commit`) は Workflow を介さずエージェントを単発起動する従来どおりの逃げ道。

migration skill と同じパターン (migration 側も将来同様に Workflow 化可能)。

## migration skill との違い (まとめ)

| 観点 | migration | feature |
|---|---|---|
| 起点 | 旧 Express/Swig コード | 会話で詰めた spec.md |
| context 充填 | 旧実装場所を grep | 再利用候補を grep + spec を引き写し |
| 互換性制約 | 旧実装と挙動一致が最優先 | なし (新規) |
| reviewer 観点 | 旧実装互換 | AC 達成 + 設計合意整合 |
| commit 単位 | 1 タスク = 1 commit | 1 タスク = N commit (commitPlan による分割) |

## 重要な前提

- **パイプライン本体は `pipeline.workflow.js`** (この skill ディレクトリ)。制御フローはここに集約。
  各 phase のエージェント定義は `.claude/agents/feature-{planner,implementer,reviewer,committer}.md`。
- **state ディレクトリは `.feature-state/` (root)** ※ `.claude/feature-state/` ではない
- **main 直コミット運用** がデフォルト (config.json `commitStrategy: main-direct`)
- 認証が要るエンドポイントは Hono の認証ミドルウェア (`createJwtAuth(crowi)`) 配下に置く。CSRF 不要
- 新契約は `packages/api-contract/src/contracts/{feature}.ts` に追加、build 必須
  (`pnpm --filter @crowi/api-contract build`)
- 新 UI は `packages/web/src/app/(auth or admin)/...` 配下、shadcn/ui + tanstack/react-query

## crowi-site ドキュメント更新

実装が終わったら、**利用者 / 運用者に見える変化** はユーザー向けドキュメント
(`apps/crowi-site/`) に反映する。これは実装と同じ流れの中で行い (planner が対象を
特定 → implementer が更新 → reviewer が確認 → committer が `docs(site)` commit に分割)、
コードと一緒に simplify / reviewer のレビュー対象に乗せる。

### ドキュメントの構成

```
apps/crowi-site/content/docs/
├── ja/                       # 日本語 (正本)
│   ├── getting-started.mdx
│   ├── guide/                # 利用者向け機能ガイド (pages / markdown / search / ...)
│   ├── operations/           # 運用・管理者向け (installation / configuration / env / admin / mcp / ...)
│   ├── plugins/              # プラグイン (overview / managing / developing / renderers)
│   ├── reference/            # 設計資料 (architecture / rfcs / contributing)
│   └── {category}/meta.json  # カテゴリ内のページ順 + タイトル
└── en/                       # 英語 (ja とミラー構成・同じファイル名)
```

- **二言語ミラー構成**: `ja/` と `en/` は同じファイル名・同じ構成。**必ず両方を更新**する
  (片方だけだと乖離する)。ja を正本として書き、en はその英訳を当てる。
- **frontmatter 必須**: 各 `.mdx` は先頭に `title` と `description` を持つ
  (`--- title: ... / description: ... ---`)。新規ページにも必ず付ける。
- **meta.json**: 新規 `.mdx` を **追加** したときは、そのカテゴリの `meta.json` の
  `pages` 配列に **ja / en 両方とも** ファイル名 (拡張子なし) を追記して順序に組み込む。
  既存ページの編集だけなら meta.json は触らなくてよい。

### 要否の判定 (planner が行う)

更新するのは **利用者 / 運用者に見える変化** のときだけ。`context.docsTargets.assessment`
に判定を記録する:

| assessment | 例 | docs 更新 |
|---|---|---|
| `user-visible` | 新しいページ機能 / 編集挙動 / 検索 / 通知 / 添付 等、エンドユーザーが触る変化 | `guide/` を更新 |
| `operator-visible` | 新 env / 新 admin 設定 / インストール手順 / プラグイン運用の変化 | `operations/` or `plugins/` を更新 |
| `internal-only` | 内部 refactor / 内部 API / テスト / 観測できない最適化 | **skip** (`entries: []`) |

`internal-only` のときは docs 更新も `docs(site)` commit も作らない。

### 対象ファイルの探し方 (planner)

1. spec の機能領域に対応する既存 `.mdx` を探す
   (`ls apps/crowi-site/content/docs/ja/{guide,operations,plugins}` + grep で関連語を検索)。
   - 既存ページがあれば `action: "edit"`、その ja / en パスを `docsTargets.entries[]` に書く。
   - 該当が無く新規トピックなら `action: "create"`、適切なカテゴリに新ファイル名を決め、
     `metaUpdate: true` を立てる (implementer が meta.json に追記する目印)。
2. env / admin 設定が増えるなら `operations/configuration.mdx` や該当運用ページも対象に含める。

`docsTargets` スキーマ:

```json
"docsTargets": {
  "assessment": "user-visible | operator-visible | internal-only",
  "entries": [
    {
      "ja": "apps/crowi-site/content/docs/ja/guide/foo.mdx",
      "en": "apps/crowi-site/content/docs/en/guide/foo.mdx",
      "action": "edit | create",
      "metaUpdate": false,
      "summary": "追記 / 新規する内容の1行メモ"
    }
  ]
}
```

### 更新 (implementer)

- `docsTargets.entries[]` の各エントリについて ja / en 両方を更新する。
- `action: "create"` なら ja / en の `.mdx` を新規作成し、`metaUpdate: true` のものは
  該当カテゴリの `meta.json` (ja / en 両方) の `pages` にファイル名を追記する。
- 既存ページのスタイル (見出し階層 / 用語 / トーン) に合わせる。RFC があれば
  `[RFC-00NN](https://github.com/crowi/crowi/blob/main/docs/rfcs/...)` 形式でリンクする
  (既存ページの慣習)。
- crowi-site は別ビルドだが、**最低限 frontmatter の有無と meta.json の整合は目視確認**する
  (壊れたリンク / 抜け落ちページを残さない)。

### commit (committer)

crowi-site の更新は **`docs(site)` scope の独立した commit** にする
(`TODO.md` 更新の `docs(todo)` とは別)。順序は `feat → test → docs(site) → docs(todo)` が典型。

## TODO.md は簡潔に保つ

`TODO.md` は **spec ではなく全体感の把握用**。肥大化させない (過去に一度 slim 化済み)。
`docs(todo)` で TODO を更新するときは:

- 完了項目は `[x]` に切り替えて **1 行に圧縮** (実装詳細・経緯は git log / RFC / spec が持つ)。
- 新規項目も 1 行。spec/RFC があれば prose を書かず `spec: feature-xxx.md` のポインタだけ。
- 1 項目 = 1 行。複数行の prose を TODO に書かない。
- crowi-site ドキュメント (`apps/crowi-site/`) が利用者向けの詳細を持つので、TODO に運用詳細を
  二重に書かない (`Operator runbooks` 節も 1 行ポインタに留める)。

## Crowi テーマ

```css
--crowi-primary: #43676b;
--crowi-header: #263a3c;
--crowi-sidebar: #f8f9fa;
```
