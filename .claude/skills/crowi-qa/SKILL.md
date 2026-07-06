---
name: crowi-qa
description: |
  実機ブラウザでの有限探索 QA skill (Bounded DevTools Charter Runner)。クリティカル
  フロー表 (`.claude/agents/feature-planner.md:84-90`) を 9 チャーターに展開し、
  操作数/リトライ/時間の上限つきで chrome-devtools MCP (優先) / claude-in-chrome
  (フォールバック) を駆動する。`packages/e2e` (決定的回帰) を置き換えず、視覚的・
  状態依存の確認と `--prod-build` (standalone ビルド) スモークを担当。findings は
  fix-or-drop、git push はしない。
  キーワード: qa, QA, 探索的テスト, exploratory testing, devtools, chrome-devtools,
  claude-in-chrome, charter, prod-build, スモーク, collab QA
---

# Crowi QA (Bounded DevTools Charter Runner)

## これは何か / 何ではないか

`crowi-qa` は **有限のブラウザ探索 QA** を行う skill。`.feature-state/specs/
feature-crowi-qa.md` が正本設計で、本ファイルはそれを実行手順に落としたもの
(設計判断そのものを変えたい場合は spec を先に直す)。

- **やること**: 対象 worktree の proxy URL (anchor+3) に対し、9 個の有限
  チャーター (§2) を順に実ブラウザで駆動し、証跡 (`.reviews/qa/<run-id>/`) と
  findings を残す。`--prod-build` で standalone ビルドの成立確認もする。
- **やらないこと** (`packages/e2e` の責務との切り分け):
  - `packages/e2e` の書き換え・Playwright テストの追加はしない。決定的回帰は
    E2E の役割のまま。
  - 新しいブラウザ自動化ライブラリを導入しない。chrome-devtools MCP と
    claude-in-chrome の既存ツールだけを使う。
  - 永続的な QA 用 DB・製品側の QA 状態モデルを追加しない。
  - `.claude/agents/feature-planner.md:84-90` のクリティカルフロー表そのものを
    拡張しない。人間がこの表を明示的に変えない限り、チャーターを増減しない。
  - リリースの自動 merge / tag / push はしない。`crowi-release` の「merge /
    tag / push / publish はすべてユーザーの明示承認後」という鉄則も変えない。
  - `packages/**` の製品コードを変更しない。QA の結果バグが見つかった場合、
    直すかどうかは fix-or-drop の対象だが、直す作業自体は呼び出し文脈
    (人間 / `integrate-worktree` / `crowi-release`) が行う。
  - QA 用テストアカウントを自動登録しない (事前に用意された認証情報を要求する)。
- **git push をしない** (証跡はすべて `.reviews/qa/` のローカル state。commit も
  しない — `.reviews/` は既存の gitignore 規約でカバーされる)。

## 起動構文

```
/crowi-qa                                   # target 省略 = 現在の worktree
/crowi-qa main                              # main worktree
/crowi-qa <worktree-key>                    # 例: /crowi-qa admin-security
/crowi-qa --url https://staging.example.com # 明示 URL (registry を経由しない)
/crowi-qa <target> --prod-build             # standalone ビルドスモークも実行
/crowi-qa <target> --charters 1,2,5         # 交差判定した charter だけに絞る (省略時は全 9)
/crowi-qa <target> --i-understand-destructive # 非ローカル --url で mutation charter を許可
```

`target` の解決順:

1. `main` (文字列そのまま)
2. worktree key (`scripts/dev-ports.mjs:45` の `normalizeWorktreeKey` と同じ
   正規化 — worktree ディレクトリ basename の `crowi-` prefix を外したもの。
   `crowi` 自体は `main` に特殊化)
3. `--url <url>` 明示指定 (registry を経由しない。§1.7 のガードが適用される)
4. 省略時 = 現在の worktree (`git rev-parse --show-toplevel` から
   `normalizeWorktreeKey` で導出)

`--charters` は選択的フック (`integrate-worktree` の交差判定、§2 相当) 用の
省略可能フラグで、指定チャーター番号 (カンマ区切り) だけを実行する。省略時は
9 チャーター全部 (full QA)。

## §1. Target 解決 (registry は read-only)

### 1.1 anchor / proxy の解決

- `~/.crowi-dev-ports.json` (`scripts/dev-ports.mjs:32` の
  `DEFAULT_REGISTRY_PATH`) を読み、`portsForAnchor(anchor)`
  (`scripts/dev-ports.mjs:57`) で `{ api, web, site, proxy }` を得る
  (`proxy = anchor + 3`)。実装コードを import せず、同等の内容を Bash /
  `node -e` で参照する:

  ```bash
  node -e "
    const raw = require('fs').readFileSync(process.env.HOME + '/.crowi-dev-ports.json', 'utf8');
    const registry = JSON.parse(raw);
    const anchor = registry['<key>'];
    if (anchor === undefined) { console.error('not running'); process.exit(1); }
    console.log(JSON.stringify({ api: anchor, web: anchor + 1, site: anchor + 2, proxy: anchor + 3 }));
  "
  ```

  registry を **書き込まない** — `allocateAnchor` (`scripts/dev-ports.mjs:223`)
  は絶対に呼ばない。対象 worktree の `pnpm dev` がまだ起動していない (`key` が
  registry に無い) 場合は、新しいアンカーを推測で採番せず
  `blocked: <target> is not running (start 'pnpm dev' in that worktree first)`
  として終了する。
- **proxy 以外へは QA しない**: raw web port (anchor+1) には直接アクセスしない。
  `/collab` / `/presence` / `/notifications` の WS は同一オリジン proxy
  (anchor+3) 経由でしか成立しない (`packages/web/src/lib/resolve-ws-url.ts` の
  doc comment、`scripts/dev-caddy.mjs` の `WS_NAMESPACES`)。proxy 以外への
  QA は WS namespace を検証できないため許可しない。

### 1.2 stale registry entry の拒否

`readRegistry` (`scripts/dev-ports.mjs:67`) は `gw end` 済み・削除済み
worktree の残留 key をそのまま返す (pruning は組み込まれていない)。target
解決の一部として毎回:

```bash
git worktree list --porcelain | awk '/^worktree /{print $2}'
```

の各パスを `normalizeWorktreeKey` と同じ規則 (basename の `crowi-` prefix を
外す。`crowi` は `main`) で正規化し、解決対象 key がこの集合に含まれることを
確認する。含まれない場合は

```
blocked: stale registry entry (worktree '<key>' not found in 'git worktree list' — the worktree has likely been closed)
```

として中断する (registry への pruning 書き込みはしない — read-only を保つ)。

### 1.3 疎通確認

`GET <proxy>/api/v2/app/info` が 200 を返すことを健全性の最低条件にする
(`packages/e2e/playwright.config.ts` の webServer readiness probe と同じ
エンドポイント)。200 でなければ `blocked: proxy not responding at <proxy url>`。

### 1.4 proxy identity 検証 (mutation を伴う charter のみ必須)

`/api/v2/app/info` (`packages/api/src/hono/handlers/app.ts`) は title /
version / capabilities のみを返し、worktree key・cwd・branch・git sha を
含まない。`gw end` 後に別プロセスが同じ proxy ポートを再利用した、等の
ポート再利用ケースを 200 応答だけでは検出できない。したがって
**mutation を伴う charter (#3・#4・#5・#9、認証 charter の mutating
サブフロー、`--prod-build`) を開始する前に**:

```bash
PID=$(lsof -iTCP:<proxyPort> -sTCP:LISTEN -t)
CWD=$(lsof -a -p "$PID" -d cwd -Fn | sed -n 's/^n//p')
# $CWD が解決対象 worktree のディレクトリ配下であることを確認
```

一致しない、または `lsof` が使えない環境では

```
blocked: cannot verify proxy process identity for <target>
```

として該当 charter (または `--prod-build`) をスキップする。**読み取り専用
charter (認証の login/logout/session サブフロー・検索・通知一覧表示・collab
の疎通確認のみ) はこの検証を必須としない** — mutation のリスクが無いため。

### 1.5 dev infra チェック (Mongo/Redis)

`packages/e2e/src/preflight.ts` と同じ発想で、対象 worktree の Mongo
(27017) / Redis (6379) への TCP 到達性を確認する (DB 分離時は接続先ホスト自体は
同じ、db 名だけが違うので TCP 到達性チェックはポート単位でよい)。落ちていれば

```
blocked: dev infra down (docker compose up -d が必要)
```

として **全チャーターを実行せずに終了する**。これは `crowi-complete-feature`
の infra-down 時の扱い (`.claude/skills/crowi-complete-feature/SKILL.md` —
fail 扱いにせず blocked として signal を立てず報告) と同じ方針。

### 1.6 active backend の preflight (API レベルの canary)

対象 worktree のランナー projectDir (dev は常に `apps/crowi-runner`) の
`crowi.config.json` を読み、`storage.driver` / `search.driver` を確認する —
これは「external driver かどうかの判定」だけに使い、**接続先 URL・認証情報は
読まない** (`crowi.config.json` にはそもそも無く、実体は Mongo Config 側に
あり暗号化される場合もある。admin API も `hasValue` に redact して返す —
`packages/api/src/hono/handlers/admin/plugins.ts`)。ES の `_cluster/health`
や S3 バケットへの直接到達確認はしない。

external driver を使う charter は、**charter 自身の最初の 1 操作を canary
として使う**:

- **検索 charter (#6)**: 最初の検索クエリを実行する。`crowi.getSearcher()`
  が未登録 (ES URL 未設定) なら `SEARCH_UNAVAILABLE_BODY` 付き 503
  (`packages/api/src/hono/handlers/search.ts`) が返る。この 503 を見た時点で
  残りのバジェットを使わず即座に `blocked: search backend unreachable (503)`
  として charter を終える。
- **添付・アップロード charter (#9)**: 最初のアップロード操作を canary として
  実行する。S3 の bucket 未設定は `requireBucket`
  (`packages/plugin-storage-aws-s3/src/index.ts`) の例外として現れるが、
  ハンドラ側は他の失敗と区別せず汎用の 500 (`UPLOAD_FAILED` /
  `INTERNAL_ERROR_BODY` — `packages/api/src/hono/handlers/attachment.ts`) を
  返すため、検索のような一意な信号が無い。最初の操作が 5xx で失敗した場合は
  「backend 未接続」と決めつけず、

  ```
  blocked: attachment charter first action failed (<status>, see network.log — ambiguous: storage backend unreachable or product bug)
  ```

  として **severity `high` の finding として記録し**、残りのバジェットを
  使わずに charter を終える (製品バグの可能性を握り潰さない)。
- ローカル driver (storage-local / search-mongo 等) しか要求しない構成では、
  この canary 分岐は発生せず charter は通常どおり全操作を実行する。

### 1.7 `--url` の扱い (destructive ガード)

`--url` 指定時は registry を経由せず、そのまま疎通確認 (1.3) のみ行う。
worktree 検証 (1.2)・proxy identity 検証 (1.4)・active backend preflight
(1.6) は可能な範囲で行い、できない部分は `environment.json` に
「worktree 検証: skipped」と明記する。

**ローカル判定の定義** (dev-port registry にホスト名は保持されていないため
read-only な導出をする): 以下のいずれかに一致すれば「ローカル」:

1. `localhost` / `127.0.0.1` かつポート番号が **解決済み anchor から
   `portsForAnchor` で導出される 4 ポート (api/web/site/proxy) のいずれか**
   に一致する。
2. `resolveTailscaleHostname()` (`scripts/dev-ports.mjs:407` — `tailscale
   status --json` から解決) が **実際に解決できた** tailscale hostname に
   一致する。

  ```bash
  node -e "
    try {
      const out = require('child_process').execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
      console.log(JSON.parse(out)?.Self?.DNSName?.replace(/\.\$/, '') ?? '');
    } catch { console.log(''); }
  "
  ```

どちらにも一致しない `--url` (社内ステージング・本番相当ドメイン等) は
**非ローカル**と判定する。

非ローカル判定の `--url` は、mutation を伴うチャーター (#3・#4・#5・#9、
認証チャーターの mutating サブフロー) と `--prod-build` を

```
blocked: destructive charter refused on non-local --url (pass --i-understand-destructive to override)
```

としてスキップする。`--i-understand-destructive` を明示した場合のみ実行する
(縮退実行や既定 override はしない)。読み取り専用チャーター (認証の
login/logout/session 遷移のみ・検索・通知一覧表示・collab の疎通確認のみ) は
`--url` のホスト制限を受けない。

## §2. 9 チャーターと対応パス表

`.claude/agents/feature-planner.md:84-90` のクリティカルフロー表を唯一の
正本として展開する (表そのものは拡張しない)。「対応パス」列は
`integrate-worktree` の選択的フック判定 (本節) に使う交差判定表:

| # | charter | 既存 E2E カバレッジ (サブフロー単位) | 対応パス (交差判定用) |
|---|---|---|---|
| 1 | 認証 (§3 で shared-DB 読み取り専用 / isolated-DB mutating の 2 層に分離) | partial: login/logout/session 遷移は `auth-state.spec.ts` がカバー (shared DB・読み取り専用)。installer 経由の admin 作成は `onboarding.setup.ts` が UI 経由で一度だけ通す happy path のみ。oauth / password reset / activation / email change は未カバー | `packages/api/src/hono/middleware/auth.ts`, `packages/api/src/hono/handlers/{tokenAuth,oauth,passwordReset,activation,emailChange,me,installer}.ts`, `packages/web/src/app/(public)/**`, `packages/web/src/app/(auth)/oauth/**`, `packages/web/src/lib/{use-auth,api-client}.ts` |
| 2 | collab (+ presence) | partial: 2 窓間 edit propagation は `collab.spec.ts` がカバー。presence (viewer 一覧・indicator) は未カバー | `packages/api/src/collab/**`, `packages/api/src/presence/**`, `packages/api/src/hono/handlers/{page-collab,presence}.ts`, `packages/web/src/components/editor/**`, `packages/web/src/lib/{use-collab-document,use-presence,resolve-ws-url}.ts` |
| 3 | ページ CRUD・rename・trash | partial: `onboarding.setup.ts` は API 経由 (`createPageViaApi`) で 1 ページを seed するのみ。UI 経由の CRUD/rename/trash は未保護 | `packages/api/src/hono/handlers/{page,backlink,page-portalize-twin}.ts`, `packages/api/src/models/{page,revision,backlink}.ts`, `packages/api-contract/src/contracts/page.ts`, `packages/web/src/app/(auth)/[[...slug]]`, `packages/web/src/app/(auth)/trash`, `packages/web/src/lib/{use-page,use-page-mutations,use-page-list,use-page-children}.ts` |
| 4 | エディタ save・draft | なし | `packages/api/src/hono/handlers/{draft,revision,page-preview}.ts`, `packages/api-contract/src/contracts/page-preview.ts`, `packages/web/src/app/(auth)/%5Fedit`, `packages/web/src/components/editor/**`, `packages/web/src/lib/{use-drafts,use-page-revisions}.ts` |
| 5 | コメント | なし | `packages/api/src/hono/handlers/comment.ts`, `packages/api/src/models/comment.ts`, `packages/api-contract/src/contracts/comment.ts`, `packages/web/src/lib/use-page-comments.ts`, `packages/web/src/components/page-comments/**` |
| 6 | 検索 | なし | `packages/api/src/hono/handlers/search.ts`, `packages/api-contract/src/contracts/search.ts`, `packages/web/src/app/(auth)/%5Fsearch`, `packages/web/src/lib/use-search.ts`, `packages/plugin-search-*` |
| 7 | 通知 | なし | `packages/api/src/notifications/**`, `packages/api/src/hono/handlers/notification.ts`, `packages/api-contract/src/contracts/notification.ts`, `packages/web/src/app/(auth)/%5Fnotifications`, `packages/web/src/lib/{use-notifications,use-notifications-socket,resolve-ws-url}.ts` |
| 8 | 管理設定 (§3 で既定 read-only) | partial: `onboarding.setup.ts` が mail SMTP 送信元アドレス保存・ユーザー招待・招待受諾をカバー。セキュリティ設定・プラグイン設定 (mail 以外)・crypto 等は未保護 | `packages/api/src/hono/handlers/admin/**`, `packages/api-contract/src/contracts/admin/**`, `packages/web/src/app/(admin)/**` |
| 9 | 添付・アップロード | なし | `packages/api/src/hono/handlers/attachment*.ts`, `packages/api/src/models/attachment.ts`, `packages/api-contract/src/contracts/attachment.ts`, `packages/web/src/app/(auth)/%5Fattachments`, `packages/web/src/lib/{use-attachments,use-attachment-usage}.ts` |

### 横断 fanout パス (複数チャーターへ OR 条件で交差)

以下は単一チャーターへの割り当てだけでは交差判定が漏れるため、**列記した
すべてのチャーターを交差対象にする** (表の割り当てに加えて OR 条件):

- `packages/web/src/lib/resolve-ws-url.ts` — `/collab` / `/presence` /
  `/notifications` が共有する WS URL 解決ロジック。charter **2・7** を
  交差対象にする。
- `packages/web/src/lib/api-client.ts`, `packages/web/src/lib/use-auth.ts`
  (トークン取得・付与・refresh) — 認証済み API 呼び出しは全チャーターが
  この共有クライアント経由。charter **1〜9 すべて**を交差対象にする。
- ランタイム env 解決 (`window.__ENV` 注入元のレイアウト、`NEXT_PUBLIC_*`
  読み出し全般) — 同様に charter **1〜9 すべて**を交差対象にする。
- `packages/api/src/util/fileUploader.ts` (すべての put/get/delete をアクティブな
  storage driver に委譲する共有層) と `packages/plugin-storage-*/` (実ドライバ
  実装) — charter **#9** の対応パスに追加する (表の #9 行はハンドラ/contract/
  web レイヤーのみで、実際の読み書きを担うこの共有 storage 層が漏れていた)。

### 共有 runtime / proxy パス (個別割り当てを試みず全 9 charter = full QA)

以下は影響範囲が「どの charter に効くか」を OR 条件では判定しきれないほど
広く (全 namespace のルーティング・全ハンドラの登録・全アクティブ driver の
解決)、変更があれば **charter を絞らず全 9 charter を対象にする**:

- `packages/api/src/hono/index.ts` — `buildHonoApp` が全 route / 全 admin
  サブリソースを登録する配線そのもの。
- `packages/api/src/plugin/plugin-manager.ts` — アクティブな storage /
  search driver の解決。
- `packages/api/src/crowi/index.ts` — boot sequence (`Crowi.init` 全体)。
- `scripts/dev-caddy.mjs` — proxy の同一オリジンルーティング表
  (`API_HTTP_PATHS` / `pickProxyTarget`)。ここが壊れると WS namespace を
  含む全 charter の疎通そのものが壊れる。

## §3. バジェットと incomplete / blocked の区別

charter 単位のデフォルトバジェット:

| 項目 | 上限 |
|---|---|
| ブラウザ操作 | 最大 10 回 |
| 失敗操作のリトライ | 最大 2 回 |
| 経過時間 (ソフト) | 5 分 |
| 経過時間 (ハード) | 8 分 |

上限到達時は **`incomplete (budget exhausted)`** としてそこまでの証跡を
確定し、粘らずに次の charter に進む。`blocked` (前提条件不足 — infra down /
資格情報なし / proxy identity 不一致 / 非ローカル `--url` 拒否 等) とは
明確に区別する:

- `blocked` = 前提条件が満たせず charter を **開始できない、または途中で
  前提が崩れた**。
- `incomplete` = charter を実際に探索したが、バジェット (操作数/リトライ/
  時間) を使い切って **打ち切った**。

### サブフロー単位の E2E カバレッジ調整 (charter 全体を一括判定しない)

- **smoke レベル (バジェットを半分程度に短縮)**: 認証 charter (#1) のうち
  login/logout/session 遷移 (`auth-state.spec.ts` がカバー)、collab charter
  (#2) のうち 2 窓 edit propagation (`collab.spec.ts` がカバー) のみ。視覚 /
  ログ / WS 証跡の確認に重点を置き、既存アサーションを再実装しない。
- **通常バジェット**: 同じ charter 内でも installer 経由の admin 作成
  (単発 happy path のみ検証済み)・oauth・password reset・activation・
  email change・presence は E2E が守っていない (または単発 happy path に
  留まる) ため通常バジェットで探索する。
- **ページ CRUD・rename・trash (#3) / 管理設定 (#8)**: バジェットを縮小
  しない。`onboarding.setup.ts` がカバーする一部 (API 経由のページ seed、
  mail SMTP 保存・ユーザー招待・招待受諾) の再確認は省略するが、それ以外
  (UI 経由の CRUD/rename/trash、管理設定の他セクション) は未保護のフローと
  同じ扱いで通常バジェットで探索する。

既存 E2E が守っているアサーションを `crowi-qa` が再実装することはない
(`.feature-state/specs/dev-cycle-skills/04-e2e-targets.md` のポイント
ポイント方針を踏襲)。

## §4. 認証 charter (#1) の 2 層構成

### 4.1 shared-DB 読み取り専用サブフロー (既定・どの target でも実行可)

login / logout / session 遷移 (同一タブ切替・別タブ logout 伝搬・reload
保持)。環境変数 `CROWI_QA_USER_EMAIL` / `CROWI_QA_USER_PASSWORD` で受け取る
既存アカウントを使う。

### 4.2 isolated-DB 限定 mutating サブフロー

対象: `POST /auth/register`・`POST /auth/activate`・`POST
/auth/reset-password`・`PUT /me` の email 変更申請 + `POST
/auth/confirm-email-change`・`POST /installer/createAdmin`・oauth
authorize/device consent (いずれも User / Config / OAuth トークンレコードを
書き換える)。

- **既定 (共有 dev DB) では実行しない**。共有 dev DB のユーザーレコードや
  installer 済み状態を書き換えると復元できない。
- **isolated DB (`dev.local.json` で `isolateDb: true` を宣言した
  worktree、または `--prod-build` の per-run DB) でのみ実行してよい**。
  それ以外 (§1.7 の非ローカル `--url` を含む) では

  ```
  blocked: mutating auth subflow requires isolated DB
  ```

  としてこれらのサブフローだけをスキップし、読み取り専用サブフロー (4.1) は
  通常どおり実行する。isolated DB 側の資格情報は `CROWI_QA_ISOLATED_ADMIN_EMAIL`
  / `CROWI_QA_ISOLATED_ADMIN_PASSWORD` で受け取る (自動登録はしない — 未設定
  なら `blocked: no credentials (isolated DB)` としてスキップ)。
- **Mailpit の稼働チェックが前提条件**: password reset の forgot-password
  は mail を fire-and-forget して常に 200 を返す・register の activation
  mail・email change の確認 mail はいずれも mail 内 token リンクを踏まないと
  完了しない。SMTP driver は host 未設定で例外を投げるため、mutating
  サブフローを始める前に `packages/e2e/src/preflight.ts` の
  `assertMailpitHttp` と同じ検査 (SMTP 1025 / HTTP 8025 への TCP 到達 +
  `GET {mailpitApiUrl}/info` または `/messages` が 200) を行い、失敗すれば
  `blocked: mailpit unreachable` としてこれらのサブフローだけをスキップする。
- **mail 内 token の捕捉**: `packages/e2e/src/mailpit.ts` の
  `waitForLatestMessageTo(email)` と同じ方式 (Mailpit HTTP API `/messages`
  を受信者アドレスでポーリングし最新メールを取得) で対象メールを取得し、
  本文から `${baseUrl}/reset-password?token=...` /
  `${baseUrl}/activate?token=...` / `${baseUrl}/confirm-email?token=...`
  のいずれかのパターンに一致するリンクを正規表現で抜き出し、そのリンクへ
  ナビゲートして charter を進める (`extractInviteLink` と同じ「既知の URL
  パターンへの正規表現マッチ」手法)。捕捉した token / リンクは §12 の
  redaction 対象に含める (生の値をログ・notes に残さない)。

## §5. 認証情報の前提 (自動登録はしない)

`crowi-qa` は対象 dev DB に既存ユーザー/管理者の認証情報が用意されている
ことを前提にする。環境変数で受け取り、未設定の場合は **該当 charter だけ**
`blocked: no credentials` として次に進む (全体を止めない):

| 環境変数 | 用途 |
|---|---|
| `CROWI_QA_USER_EMAIL` / `CROWI_QA_USER_PASSWORD` | 一般ユーザー (auth 読み取り専用サブフロー・collab・ページ CRUD 等) |
| `CROWI_QA_ADMIN_EMAIL` / `CROWI_QA_ADMIN_PASSWORD` | 管理設定 charter (#8、read-only 確認用) |
| `CROWI_QA_ISOLATED_ADMIN_EMAIL` / `CROWI_QA_ISOLATED_ADMIN_PASSWORD` | isolated DB (`isolateDb: true` worktree) 限定の mutating サブフロー用。この worktree でまだ資格情報が無ければ人間が一度だけ installer/register を回して用意する |

多くの worktree は既定で main と DB を共有しており (`readDevLocalConfig` が
返す `isolateDb` は既定 `false`)、テストアカウントの自動作成は共有 dev
データを汚すリスクがある — したがって **どのケースでも自動登録はしない**。

## §6. run id・ページ作成 path prefix・cleanup

### 6.1 run id

`<UTC yyyymmdd-HHMMSS>-<4 桁乱数 または pid>-<target>` 形式 (例
`20260705-134502-7931-main`)。同一 target に対して同じ秒に複数の
`crowi-qa` プロセスが起動しても衝突しないようにする。証跡ルート
(`.reviews/qa/<run-id>/`) もこの run id を使う。

```bash
RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$$-<target>"
```

### 6.2 ページ作成の path prefix

charter が作成するページ・コメント・添付は、必ず run 専用の一意な path
prefix 配下に置く: `/qa/<run-id>/<charter>/...`。

### 6.3 manifest と hard delete による cleanup

charter は作成したページの id を、作成した **その場で** run のエビデンス
ルート配下の manifest ファイル `.reviews/qa/<run-id>/created.json` (配列。
各要素 `{ pageId, path, charter }`) に追記する。

charter 終了時のクリーンアップは、**この manifest に記録された page id
のみ**を対象に **hard delete** (`DELETE /pages` を `completely: true` で
呼び、`Page.completelyDeletePage` に落とす) を行う。`completely: true` は
レビジョンチェックをバイパスし、bookmark・comment・attachment (バッキング
storage オブジェクトごと)・redirect origin・activity を丸ごと削除するため、
対象を誤ると共有 dev DB の既存データを永久に失う。

> **推奨実装 (実測済み)**: 認証済みブラウザセッションの `fetch()` を
> `evaluate_script` 経由で manifest の id ごとにループさせる — セッションの
> 認証がそのまま乗るので curl 用の JWT 取得が不要で、削除の 200/404 応答も
> その場で確認できる。

- **fallback 確認**: manifest が壊れている / 読めない場合に **限り**、
  path が `/qa/<run-id>/...` prefix 配下 かつ creator がこの run の QA
  アカウントと一致するページを候補として列挙し、削除前に `findings.md` に
  列挙して manifest 破損の事実とともに報告する (manifest が健全なときは
  この fallback 列挙は行わない)。どちらの経路でも一致しないページには
  削除も soft-delete もせず、既存データに一切触れない。
- **通常の soft delete は使わない理由**: `Page.deletePage` (`completely`
  省略) は `status: deleted` にして `/trash/...` へリネーム + redirect
  page を作るだけで実データ (ページ本体・コメント・添付) は残り、かつ
  `Page.path` は unique index なので同一パスを次回 run が再利用すると
  衝突する。したがって manifest (または fallback で確認できた) ページは
  hard delete で完全に除去し、それ以外のページはゴミ箱にも入れず何もしない。
- hard delete に失敗した場合は `summary.md` に残留物 (page id / path) を
  明記する (運用側が手動で削除するための情報)。

## §7. 管理設定 charter (#8) は既定で read-only

セキュリティ設定は Config を永続変更し (`packages/api/src/hono/handlers/
admin/security.ts`)、crypto カードの再暗号化は sensitive config の値を
書き換える (`packages/web/src/components/admin/crypto-status-card.tsx`,
`packages/web/src/lib/use-admin-crypto.ts`, `packages/api/src/hono/
handlers/adminCrypto.ts`)。共有 dev DB (既定) ではこれらのグローバル設定を
**実際に変更しない** — 画面表示・入力バリデーション・保存前 confirm
ダイアログの確認までを行い、実際の保存 / 再暗号化ボタンは押さない。

Config を実際に変更する検証は、`dev.local.json` で `isolateDb: true` を
宣言した worktree に対してのみ実施してよい。

## §8. 証跡モデル

### 8.1 ディレクトリ構造

```
.reviews/qa/<run-id>/
  summary.md          # charter 別 pass/blocked/incomplete + 全体 verdict
  environment.json    # target/proxy URL/git sha/driver/infra 状態/--prod-build 有無
  findings.md         # fix-or-drop の findings (§9)
  created.json        # manifest (§6.3)
  flows/<charter>/
    notes.md
    screenshots/*.png
    console.log
    network.log
  prod-build/          # --prod-build 実行時のみ
    build.log
    server.log
    smoke-notes.md
    screenshots/*.png
```

`.reviews/` は既存の gitignore 済み local state 規約 (`integrate-worktree`
の `.reviews/` / `crowi-review` の `.reviews/crowi-review/`) を踏襲する。
commit しない。

> **実測済みの注意**: ハーネスの Write ガードが `findings.md` / `summary.md` 等の
> ファイル名 (report/summary/findings/analysis を含む .md) への Write ツール書き込みを
> 拒否することがある。その場合は **Bash heredoc で書く** (`cat > ... <<'EOF'`)。
> ファイル名自体は変えない (この構造が契約)。

`summary.md` の verdict には、`--prod-build` を実行した場合
`prod build verified` / `prod build unverified: <reason>` /
`prod build skipped: <reason>` も併記する。

### 8.2 保持ポリシー

`crowi-qa` は自動削除ロジックを持たない (誤削除を避ける)。同一 target の
直前 run は上書きせず残す (比較用)。肥大化したら運用側が手動で
`.reviews/qa/` 配下を掃除する。

## §9. findings と fix-or-drop

フィールド: `id` / `title` / `severity` (`critical` / `high` / `medium` /
`low` — `crowi-review` の findings schema と同じ enum) / `flow` /
`environment` / `repro` / `expected` / `actual` / `evidence` (スクショ・
ログへの相対パス) / `disposition` (`fixed` | `dropped: <reason>`)。

`crowi-qa` 自身は製品コードを直さない (このスキルはドキュメント/報告に閉じる)。
disposition の実行 (直す/捨てる) は呼び出し文脈の責務:

- **単体起動** (人間が直接 `/crowi-qa` を叩いた場合) — その場で直すか、
  理由を添えて drop する。`TODO.md` への退避は禁止。
- **`integrate-worktree` から呼ばれた場合** — Step 7 の simplify と同じ
  「その場で直すか、報告 1 行で捨てる」運用に findings を合流させる。
- **`crowi-release` の pre-flight から呼ばれた場合** — pre-flight は
  read-only (git 状態を変更しない) なので、未解決の high/critical
  findings は Go/No-Go 材料の「リスク / 未検証」欄にそのまま出す。
  pre-flight 自身が直すことはしない。

**findings は fix-or-drop。TODO への退避は全ケースで禁止** (全 skill 共通
方針)。

## §10. ブラウザドライバの優先順位と証跡取得

優先順位: **chrome-devtools MCP → claude-in-chrome → どちらも使えなければ
`blocked: no browser driver available`** (証跡が取れない状態で QA を
続けない。縮退実行はしない)。

### 10.1 chrome-devtools MCP (優先)

`navigate_page` / `click` / `fill` / `evaluate_script` / `wait_for` で
charter の操作を行い、証跡は以下で取る:

- スクリーンショット: `take_screenshot`
- コンソール: `list_console_messages` / `get_console_message`
- ネットワーク: `list_network_requests` / `get_network_request`

### 10.2 claude-in-chrome (フォールバック)

`navigate` / `find` / `form_input` / `computer` で charter の操作を行い、
証跡は以下で取る:

- **スクリーンショット**: `computer` ツールを `action: "screenshot"` で
  呼ぶ (Anthropic computer-use tool の標準アクション)。戻り値の画像
  (base64 PNG) をデコードし、`chrome-devtools MCP` の `take_screenshot`
  と同じ命名規約で `.reviews/qa/<run-id>/flows/<charter>/screenshots/
  <連番>.png` に保存する:

  ```bash
  # $SCREENSHOT_BASE64 は computer(action="screenshot") の戻り値
  echo "$SCREENSHOT_BASE64" | base64 -d \
    > ".reviews/qa/<run-id>/flows/<charter>/screenshots/$(printf '%02d' "$N").png"
  ```

  撮影タイミングは chrome-devtools MCP 側と揃える: charter 開始直後の画面
  ロード後・charter の各操作直後・finding を発見した時点、の最低 3 回。
- コンソール: `read_console_messages`
- ネットワーク: `read_network_requests`
- 画面構造 (要素特定・アサーション補助であり、スクリーンショットの代替では
  ない): `read_page`

証跡フォーマット・バジェットはどちらのドライバでも変わらない。
`environment.json` に使用したドライバ (`chrome-devtools-mcp` /
`claude-in-chrome`) を記録する。

### 10.3 WS 証跡: 主 evidence と application-level fallback

**実測済み (2026-07-06 初回 run)**: chrome-devtools MCP の
`list_network_requests` は `resourceTypes:["websocket"]` を指定しても
**この driver + proxy 構成では WS entry を表示しない** (collab が実際に動いて
いる状況下で 0 件)。したがって WS 証跡の探索に budget を使わず、**最初から
下記の application-level evidence を主 evidence として使う**。別 driver /
構成で WS upgrade (101) やフレームが network 証跡に見えた場合は、それを
追加 evidence として記録してよい (見えなくても製品バグではない)。

application-level evidence (namespace 別、budget 内に現れなければ
`incomplete (budget exhausted)` として §3 のバジェット定義と同じ扱い):

| namespace | fallback pass 条件 |
|---|---|
| `/collab` | charter #2 の 2 窓編集伝搬そのもの (一方のウィンドウでの編集がもう一方のウィンドウ内に budget 内で反映される) |
| `/presence` | 2 つ目の独立セッション (§11 の 2-window 制約と同じ) を開いた状態で、一方の画面の viewer 一覧 / presence インジケータにもう一方のセッションが budget 内に出現する |
| `/notifications` | 通知を発生させる操作 (例: 他ユーザーへのコメント mention) の後、リロードせずに通知ベルのカウント増加 または toast 表示が budget 内に現れる |

collab charter は `CLAUDE.md` の既存 2 窓スモーク手順をそのまま吸収し、
`/pages/:id/yjs-token` (`packages/api/src/hono/handlers/page-collab.ts`) /
`/pages/:id/presence-token` (`packages/api/src/hono/handlers/presence.ts`)
への往復を経て編集が伝搬することを確認する。

## §11. 2-window collab charter の制約

JWT はブラウザプロファイル単位で共有される (タブ単位ではない —
`packages/e2e/tests/auth-state.spec.ts` のコメントが「同一タブで別ユーザー
としてログインすると既存のトークンペアが上書きされる」と明記している)。
したがって 2 ユーザー同時編集の伝搬確認には **同一プロファイル内の 2 タブ
では不十分**で、独立したブラウザコンテキストが必要。

**まず chrome-devtools MCP の `new_page({ isolatedContext: "<name>" })` を試す**
— 独立した cookie jar を持つ 2 セッションを 1 MCP セッション内に作れることを
実測済み (2026-07-06 初回 run で 2 窓検証をフル実行)。claude-in-chrome 等、
使用中のドライバに同等機能が無く 2 つ目の独立コンテキストを開けない場合のみ、
2-window 側の伝搬確認は

```
blocked: cannot isolate second session
```

とし、単一セッションでの疎通確認 (ページロード・エディタマウント・WS
接続) だけに縮退する。

## §12. redaction ルール (証跡への機密漏洩防止)

管理設定チャーター (#8) を含む **全チャーター**で、証跡 (`network.log` /
`console.log` / スクリーンショット) に機密が写り込むことを禁止する。
redaction は「書き出してから消す」のではなく、**証跡を `network.log` /
`console.log` へ書き出す時点、かつ `.claude/scripts/codex-run.sh` への
offload (§13) より前に**必ず適用する — 生の値が一度でもディスクに触れる
経路を作らない。

- すべての HTTP リクエスト/レスポンスは、書き出し前に `Authorization`
  ヘッダ **と** `Cookie` ヘッダ全体を `[REDACTED]` に置換する。`Cookie` は
  `crowi.accessToken` (`packages/web/src/lib/auth-token.ts` が login/refresh
  で書き込む同一オリジン cookie) を含み、`Authorization` が無い `<img>`
  等のリクエストでも api 側 `jwtAuth` ミドルウェアがこの cookie を bearer
  相当として受理するため、ヘッダ名だけ見て `Authorization` のみを消すと
  Cookie 経由のトークンが残る。
- 認証系エンドポイントの request / response **body** も同様にフィールド
  単位で redact する (ヘッダだけでは不十分):
  - `POST /auth/login` の request body の `password`、response body の
    `accessToken` / `refreshToken`。
  - `POST /auth/refresh` の request body の `refreshToken`、response body
    の `accessToken` / `refreshToken`。
  - WS トークン応答: `GET /pages/:id/yjs-token` の `wsToken`、
    `GET /pages/:id/presence-token` の `token`、
    `GET /notifications/token` の `token`。
  - これらのフィールドは値の型 (JWT 文字列) ではなく **フィールド名で機械的
    にマッチ**して `[REDACTED]` に置換する (`password` / `accessToken` /
    `refreshToken` / `wsToken` / `token` をキーに持つ JSON ノードを再帰的に
    置換)。
- ブラウザ状態のダンプ (`localStorage` の `accessToken` / `refreshToken`、
  `document.cookie` の内容) を証跡として保存する場合も同じ redaction を
  適用する — `evaluate_script` / `computer` 等で状態を読んだ結果をそのまま
  `notes.md` / ログに貼らない。
- 認証 charter の mutating サブフロー (§4.2) が Mailpit から捕捉するメール
  本文・reset/activate/confirm-email の各リンク・そこに含まれる token も
  同じ扱い — メール本文全体を `notes.md` / ログに貼らず、`[REDACTED]` に
  置換した上で「メールを受信し token リンクへ遷移した」という事実だけを
  記録する。
- `POST /admin/users/{id}/reset-password` は平文パスワードを返す仕様
  (`packages/api-contract/src/contracts/admin/users.ts`、UI 側は readonly
  input で表示 — `packages/web/src/components/admin/
  user-action-dialogs.tsx`) であり、管理設定チャーターはこのアクションを
  **実行しない** (fixture の既存ユーザーのパスワードをリセットしない)。
  誤って実行した場合はレスポンスボディ・ログ・スクリーンショットの該当
  箇所を証跡から削除する。
- プラグイン設定の `@sensitive` マーカー付きフィールド (例
  `packages/plugin-aws/src/index.ts` の S3 secret access key、
  `packages/plugin-slack/src/index.ts` の bot token / signing secret —
  マーカーの定義は `packages/plugin-api/src/schema-markers.ts`) の値は
  `network.log` の request body / response body から `[REDACTED]` に置換
  する。管理設定チャーターは既存のプラグイン設定値を **変更しない**
  (フォームの到達・表示確認までに留め、実際の値の入力・保存は行わない —
  更新 API は送信された値をそのまま Config へ書き込むため誤操作が本番
  相当の設定を汚す)。
- スクリーンショットに上記の値やトークンが写る操作は撮影前に該当
  フィールドをマスク (blur/hide) してから撮影する。
- `.claude/scripts/codex-run.sh` へのログオフロード (§13) は **redaction
  済みのログのみ**を渡す (生ログを外部プロセスに渡さない)。

## §13. codex-run.sh へのログ解析オフロード

各 charter のコンソール/ネットワークログをキャプチャした後 (§12 の
redaction 済みログのみ)、`.claude/scripts/codex-run.sh --sandbox
read-only` (exec モード) にプロンプト + strict JSON schema を渡して要約
させる (`crowi-review` の Stage 0 と同じ枠組みを踏襲)。

```bash
mkdir -p .reviews/qa/<run-id>/flows/<charter>
cat > .reviews/qa/<run-id>/flows/<charter>/prompt.md <<'PROMPT'
Analyze the following (already redacted) browser console log and network log
for a QA charter run. Report console errors, failed network requests, and the
WebSocket upgrade/frame status per namespace (collab/presence/notifications,
if applicable to this charter). Return JSON matching the output schema.
PROMPT
cat > .reviews/qa/<run-id>/flows/<charter>/schema.json <<'SCHEMA'
{ "type": "object", "required": ["consoleErrors", "failedNetworkRequests", "wsStatus", "summary", "severityCandidates"],
  "additionalProperties": false,
  "properties": {
    "consoleErrors": { "type": "array", "items": { "type": "string" } },
    "failedNetworkRequests": { "type": "array", "items": { "type": "string" } },
    "wsStatus": { "type": "array", "items": {
      "type": "object", "required": ["namespace", "status"], "additionalProperties": false,
      "properties": { "namespace": { "type": "string" }, "status": { "type": "string" } }
    } },
    "summary": { "type": "string" },
    "severityCandidates": { "type": "array", "items": { "type": "string" } }
  }
}
SCHEMA
bash .claude/scripts/codex-run.sh --sandbox read-only \
  --prompt-file .reviews/qa/<run-id>/flows/<charter>/prompt.md \
  --schema-file .reviews/qa/<run-id>/flows/<charter>/schema.json \
  --out .reviews/qa/<run-id>/flows/<charter>/analysis.json --label crowi-qa
```

(schema は OpenAI strict mode 準拠 — `additionalProperties: false` + 全
property を `required` に。緩めると codex が 400 で落ちる。)

exit code で分岐:

- **0** → 結果を `findings.md` に合流。
- **2** (codex 不可) / **3** (出力不正) → Claude 側がその場で同じ
  (redaction 済み) ログを読んで代替判定する (`crowi-review` の fallback と
  同じ — オフロードの失敗を run 全体の失敗にしない)。

## §14. `--prod-build` モード

`@crowi/web` の standalone ビルドと `@crowi/api` の本番ビルドを実際に
起動し、ログイン/ホーム/管理/エディタの画面が本番相当の構成 (同一オリジン
proxy 経由) で動くかをスモーク確認する。**mutation を伴うため §1.7 の
`--url` ガード対象**で、`--i-understand-destructive` なしでは非ローカル
`--url` に対して実行しない。

### 14.1 web: standalone ビルド

```bash
pnpm --filter @crowi/web build
```

standalone tree (`packages/web/.next/standalone/`) は `.next/static` と
`public/` を含まない (`packages/web/Dockerfile` が Docker で明示的にコピー
している挙動と同じ) ため、ローカル実行でも手動でコピー/シンボリックリンク
してから起動する:

```bash
cp -r packages/web/.next/static packages/web/.next/standalone/packages/web/.next/static
cp -r packages/web/public packages/web/.next/standalone/packages/web/public
PORT=<webPort> HOSTNAME=127.0.0.1 node packages/web/.next/standalone/packages/web/server.js
```

### 14.2 api: ランナー cwd からの本番起動

本番の plugin/config 解決はプロセスの cwd に依存する
(`PluginManager.bootstrap()` は projectDir 省略時に `process.cwd()` を
使い、`@crowi/runner` はそこから `crowi.config.json` を読んで plugin を
解決する)。したがって `packages/api/dist/app.js` を repo root や
`packages/api` から起動してはならない — `apps/crowi-runner/
crowi.config.json` の S3/Elasticsearch/renderer/slack plugin 選択を無視し、
`crowi.config.json` が見つからない cwd での暗黙のデフォルト driver で
起動してしまう。本番 Docker イメージも同じ理由でランナープロジェクトを
deploy し、ランナーの projectDir で起動している。

```bash
pnpm --filter @crowi/runner-app... build   # @crowi/api + 依存 plugin 一式
cd apps/crowi-runner   # dev の起動と同じ cwd (apps/crowi-runner/node_modules/@crowi/api は pnpm workspace symlink)
```

### 14.3 DB: run 専用の per-run isolated DB (サニタイズ済み環境)

対象 worktree の共有/isolated DB をそのまま使わず、**run 専用の使い捨て
DB 名**を使う: `crowi_qa_prod_<run-id>` (§6.1 の run id、命名 prefix
スタイルは `isolatedDbName` を踏襲)。固定名をやめることで、複数の
`--prod-build` run が同時に走っても installer state を共有せず、lock /
lease の類は不要になる。

**api の起動はサニタイズした環境で行う**: `packages/api/src/crowi/
index.ts` の Mongo URI フォールバック順は
`MONGOLAB_URI || MONGODB_URI || MONGOHQ_URL || MONGO_URI || 'mongodb://localhost/crowi'`
— `MONGO_URI` より **優先される** 3 つの環境変数が呼び出し元のシェル/CI に
残っていると、`MONGO_URI` を渡しても無視されて意図しない DB (共有 dev DB
や本番相当環境) に接続してしまう。したがって起動プロセスには継承した環境を
そのまま渡さず、`MONGOLAB_URI` / `MONGODB_URI` / `MONGOHQ_URL` を明示的に
unset した上で `MONGO_URI=mongodb://localhost/crowi_qa_prod_<run-id>` だけを
設定する:

```bash
env -u MONGOLAB_URI -u MONGODB_URI -u MONGOHQ_URL \
  MONGO_URI="mongodb://localhost/crowi_qa_prod_<run-id>" \
  NODE_ENV=production PORT=<apiPort> \
  node node_modules/@crowi/api/dist/app.js
```

呼び出し元の環境で unset が信頼できない (サブシェル分離ができない、値の
上書きを確認できない等) 場合は、実際にどの DB に繋がるか保証できないため
**fail-closed** で

```
blocked: conflicting Mongo env var present (MONGOLAB_URI/MONGODB_URI/MONGOHQ_URL) — cannot guarantee isolation
```

として `--prod-build` を起動せずに打ち切る (推測で進めない)。起動後は
接続先 DB 名をログに出し、`crowi_qa_prod_<run-id>` に接続していることを
確認してから後続の provisioning 手順に進む。

### 14.4 DB ライフサイクル (provisioning)

この DB は当該 run の `--prod-build` が排他的に所有し、他 run・人間の dev
セッションとは共有しない使い捨て DB である。§5 の「テストアカウントの
自動作成はしない」は共有 dev DB を汚さないための方針であり、この専有 DB
には適用しない — 以下の手順で自己完結的に provisioning する:

1. 起動後、`GET <一時 proxy>/api/v2/installer` で状態を確認する。新規の
   per-run DB なので通常は常に `installer_required` になる。
2. `installer_required` の場合: `POST /installer/createAdmin` を、この run
   専用の固定資格情報 (実運用の秘密情報ではない。`packages/e2e/src/
   config.ts` の `e2eUsers.admin` と同じ発想の固定値、例
   `crowi-qa-prodbuild@example.com` / 固定パスワード) で呼び、管理者を
   作成する。
3. `already_installed` が返る場合 (直前 run の drop が失敗して DB が残存
   した等、想定外のケース): 手順 2 と同一の固定資格情報でログインを試す。
   成功すればそのまま再利用してよい。失敗する場合は DB が想定外の状態に
   あるとみなし、

   ```
   blocked: prod-build DB in unexpected state (reset or drop crowi_qa_prod_<run-id> manually)
   ```

   として `--prod-build` を打ち切る。
4. スモーク対象の「エディタ」画面は同じ固定管理者アカウントで到達確認する
   (この DB は当該 run 専用の使い捨てで、複数ユーザーの協調編集を検証する
   対象ではない — 多ユーザーの collab/presence 検証は charter #2 が別途
   担当する)。エディタ URL は `page_id` または `path` が無いと
   `InvalidParamsView` になり編集画面が開かないため、この固定管理者で
   `/qa/<run-id>/prod-build` のようなページを 1 枚新規作成 (page create
   API 経由) してから、そのレスポンスに含まれる page id で
   `/_edit?page_id=<作成した page id>` を開く。

### 14.5 一時 proxy

`scripts/dev-caddy.mjs` の `startNodeProxyFallback()` をそのまま流用し、
`{ apiPort, webPort, proxyPort }` にこの一時プロセス群を割り当てて同一
オリジンで前段する (自己ホスト本番の推奨トポロジを模す)。この一時 proxy は
dev-port registry には一切登録しない (実行中の worktree の anchor と
衝突しない、使い捨てのポートを都度 OS プローブで選ぶ)。

### 14.6 スモーク

この一時 proxy (`http://127.0.0.1:<proxyPort>`) 経由で以下の URL に順に
アクセスし、いずれも 200 応答 (エディタは HTML 200 かつエディタ本体の
マウント確認) とコンソールエラー無しを確認する。ログイン画面は 14.4 の
固定管理者資格情報で実際にログインし、それ以降のホーム/管理/エディタは
同一セッションのまま到達確認する:

| # | 画面 | URL |
|---|---|---|
| 1 | ログイン | `<proxy>/login` (固定管理者資格情報でログインまで行う) |
| 2 | ホーム | `<proxy>/` |
| 3 | 管理 | `<proxy>/admin` |
| 4 | エディタ | `<proxy>/_edit?page_id=<14.4 手順 4 で作成した page id>` |

各 URL について 画面遷移 → §10 のスクリーンショット取得 →
コンソール/ネットワークログ確認、の順で証跡を
`prod-build/screenshots/*.png` に保存する (§8.1 の `prod-build/` 配下)。
いずれかが 200 以外・コンソールエラーあり・エディタがマウントしない場合は
`prod build unverified: <reason>` として §8.1 の verdict に記録する
(残りの URL の確認は続けてよい — 打ち切らず全 4 URL を試した上で
unverified の理由を列挙する)。

### 14.7 後始末

成否によらず api / web / proxy プロセスを必ず終了する (残存プロセスを
残さない)。DB は run 専用の使い捨てなので、**成否によらず smoke 終了時に
`crowi_qa_prod_<run-id>` を drop する** (次回 run は新しい run id で新しい
DB を provisioning するため、固定資格情報を次回のために残す必要はない)。
drop に失敗した場合は `summary.md` に残留 DB 名を明記する (運用側が手動で
削除するための情報。14.4 の `already_installed` fallback がこのケースを
拾う)。

結果は `summary.md` の verdict に `prod build verified` /
`prod build unverified: <reason>` として記録する。`crowi-release` の
pre-flight はこの verdict をそのまま Go/No-Go 材料に転記する。

## 参照 (再利用元)

- `.claude/skills/crowi-review/SKILL.md` — frontmatter 構造・`.reviews/`
  規約・`codex-run.sh --sandbox read-only` への strict JSON schema offload
  パターン (§13 はこれを踏襲)。
- `.claude/skills/integrate-worktree/SKILL.md` — 番号付きワークフロー
  記述スタイル・`gw` ラッパー前提・main-direct 運用の書き方。
- `.claude/skills/crowi-release/SKILL.md` — モード分岐コマンド構文、
  pre-flight は read-only という書き方、Go/No-Go 材料提示フォーマット。
- `scripts/dev-ports.mjs` — `DEFAULT_REGISTRY_PATH` / `normalizeWorktreeKey`
  / `portsForAnchor` / `readRegistry` / `readDevLocalConfig` /
  `isolatedDbName` / `resolveTailscaleHostname` (すべて read-only 参照。
  `allocateAnchor` は呼ばない — `crowi-qa` は専用スクリプトを持たず、上記の
  挙動と同等のコマンドを Bash 経由で実行する)。
- `scripts/dev-caddy.mjs` — `WS_NAMESPACES` / `API_HTTP_PATHS` /
  `pickProxyTarget` / `startNodeProxyFallback` (`--prod-build` の一時
  proxy 起動、同一オリジンルーティング判定の参照実装)。
- `packages/e2e/src/preflight.ts` — Mongo/Redis/Mailpit TCP 到達性チェックの
  実装パターン (import はしない — `crowi-qa` はエージェントが直接
  Bash/MCP ツールを呼ぶプロース skill)。
- `packages/e2e/src/mailpit.ts` — `waitForLatestMessageTo` /
  `extractInviteLink` (Mailpit HTTP API からのメール取得 + 正規表現マッチ
  による token リンク捕捉手法)。
- `packages/e2e/src/config.ts` — `e2eUsers` (固定資格情報の命名パターン。
  `--prod-build` 用の固定 QA 資格情報の命名で流用)。
- `.claude/agents/feature-planner.md:84-90` — クリティカルフロー表
  (9 charter 展開の唯一の正本 — 表そのものは拡張しない)。
- `.claude/scripts/codex-run.sh` — 既存の offload wrapper (新規スクリプトを
  作らずそのまま呼ぶ)。

## 鉄則 (まとめ)

- **git push をしない**。証跡は `.reviews/qa/` に置く (commit しない)。
- **registry を書き込まない** (`allocateAnchor` を呼ばない)。新しい
  worktree のアンカーを推測で採番しない。
- **QA 用の認証情報は環境変数で受け取る**。未設定時は該当 charter だけ
  `blocked: no credentials`。自動でテストアカウントを登録しない。
- **findings は fix-or-drop**。TODO への退避は禁止 (全 skill 共通方針)。
- **共有 dev DB では破壊的操作を行わない**。mutation を伴う認証サブフロー・
  管理設定の実変更は isolated DB (または `--prod-build` の per-run DB)
  限定。
- **chrome-devtools MCP → claude-in-chrome → blocked** の優先順位を守り、
  縮退実行はしない。
