# TODO List

Crowi 2.0 (Express + Swig → Next.js + Hono)。**2.0.0-alpha.3 リリース済み・alpha.4 準備中**。

> このファイルは**全体感の把握用**。実装詳細・経緯は書かない（肥大化防止）。
> 詳細は git log / RFC (`docs/rfcs/`) / spec (`.feature-state/specs/`) を参照。
> 各項目は原則 1 行。spec/RFC があればポインタだけ残す。

---

## 🎯 Now

alpha.0–.3 は published、alpha.4 / stable 向けに changeset 蓄積中（pre(alpha) mode）。
直近の active 作業は worktree `feature-slack`（Slack plugin, RFC-0013）。具体タスクは High Priority を参照。

---

## High Priority — 進行中

### Plugin Architecture (RFC-0001)
- [x] Slack plugin Phase 0/1 完成（unfurl まで）: registerRoutes SDK 配線 + `@crowi/plugin-slack`（manifest/`ctx.appInfo()`/admin "platform" section 含む。spec: `feature-slack-plugin.md`）。残: Phase 2 slash+write（**auth-plugin RFC-0014 と連動・別途**）/ Phase 3 notifier / Phase E embed
- [ ] Step 10: auth provider plugin 化（OAuth。alpha1 で削除、将来 plugin で復活）
- [ ] 将来: encryption KeyProvider plugin (KMS)、S3 以外の attachment storage

### OAuth 2.0 (RFC-0010)
- [ ] Phase 5: admin による任意 OAuth クライアント登録 UI（Phase 1-4 完了）

### 配布 / リリース（2.0.0 stable 時）
- [ ] **無印 `crowi` パッケージの整理**（spec: `feature-crowi-quickstart-package.md`）
- [ ] **slim image + 外部 operator 向け doc** — runner-project 方式。blocked-on `feature-plugin-search-mongo`

### 管理画面 残（フェーズ4）
- [ ] Slack channel 通知（page-path→channel mapping + Slack 統合設定）

### その他 残作業
- [ ] error code 細分化（comment/revision の `INVALID_REQUEST`）
- [ ] web テスト基盤整備 + API coverage 強化

---

## バックログ（機能ロードマップ残 / dep major 待ち）

レビュー / simplify の advisory はここに積まない（**fix or drop** — 直すか捨てるかの二択。CLAUDE.md「Review findings: fix or drop」参照）。残すのは機能ロードマップ残と dep major 待ちのみ。

- [ ] **E2E coverage (point-by-point)**: page CRUD → editor save/draft → comments → search → notifications → admin の順で、新機能/バグ修正のついでに `packages/e2e` を拡充（一括タスクにしない。運用は e2eTargets — feature-planner.md 参照）
- [ ] **RFC-0002 renderer 残**（Mermaid、GitHub Embed plugin、mention N+1 ほか）
- [ ] **monorepo restructure follow-ups**（catalog 化、compose healthcheck、dev/prod parity ほか）
- [ ] **crypto Phase 3**（KeyProvider pluggable 化、lookup-key secret の hash 化）
- [ ] **RFC-0008 follow-ups**（`rebuild renderer`/`backlink` 本実装、watcher backfill 統一、RFC 追従）
- [ ] **eslint 8 → 9 major up**（`packages/api` / `packages/collab` の direct eslint 8.57.1。flat config 統一含む。GHSA `js-yaml` advisory が transitive 経由で残るのは eslint 8 chain が `@eslint/eslintrc → js-yaml@4.1.1` を要求するため）
- [x] **mongoose 8 → 9 major up**（`packages/api` / `packages/collab` / `packages/plugin-search-mongo`。mongodb 6→7・mms 10→11 同伴。GHSA `ip-address` chain は mongoose major とは直交し、root `pnpm.overrides` の `"socks": "^2.8.7"` で解消）

---

## ✅ 完了済み（主なマイルストーン）

- **2.0.0-alpha.0 / .1 / .2 リリース** — 外部共有機能の削除（Share モデルは dormant 据え置き・LinkSharePopover は残置）/ ソーシャルログイン削除（Google/GitHub。認証ポリシー設定は不活性化で残置）/ 通知設定メニュー削除 / renameTree 移行（`POST /pages/rename` の `include_descendants`）/ version bump + tag（spec: `feature-v2-alpha1-release-prep.md`）
- **v1→v2 データ移行（RFC-0008）** — migration framework + HTML タグ移行の不具合修正（wikilink close-tag 誤爆 + TOC HTML 混入の修復）+ wikilink-format コード領域除外（`code-mask.ts` の `splitCodeSegments` / `rewriteOutsideCode` で 3 body-rewrite migration を非コードセグメント経由に統一）+ apply タイムスタンプ保全 + preflight severity 分割（migration 毎に `severity:'cosmetic'|'blocking'`、boot probe を severity 別に。cosmetic pending は warn-and-continue、`user-unique-prepare` のみ blocking で起動拒否。永続起動拒否デッドロック解消。CLI に `[blocking]`/`[cosmetic]` タグ。spec: `feature-migration-preflight-severity.md`）
- **配布 / リリース基盤** — runner-project 方式（spec: `feature-prod-runner-project.md`）/ web image の API URL 実行時注入（同一・クロスオリジン。spec: `feature-web-image-runtime-config.md` / `feature-web-cross-origin-runtime-env.md`）/ CI リリース自動化（changesets + npm OIDC + Docker full/slim + ES image。spec: `feature-ci-release-automation.md`）
- **特定 revision への revert** — stale 帯の「この版に戻す」+ `POST /pages/revert-to-revision` + MCP `crowi_revert_to_revision`（非破壊・portal 対応。spec: `feature-revision-revert.md`）
- **web auth state 集約（fugu-report P0-1）** — `useAuth` を `['auth','me']` の React Query singleton 化（thin wrapper）+ token-presence を `useSyncExternalStore` の reactive store（`auth-token-store.ts`）に切出し / listener を `AuthSync` island に集約。cross-user cache leak 解消（logout / session-expired / cross-tab logout で `clear()`、account-switch で remove+reset）+ 他タブ logout 伝播 + inline-reauth 後の user 復活 + エディタ in-place 回復（spec: `feature-web-auth-state-centralization.md`）
- **閲覧中ページのライブ差し替え（read-side soft-refresh）** — 他者保存で閲覧中の本文をフルリロードなしで最新 revision へ差し替え + 上部中央固定バナー（更新通知 / 以前の版へ戻す / さらに新しい版）。既存 `/presence` WS チャネルに page-updated を相乗り（Approach A・新規 WS なし）+ `crowi:presence:page-updated` Redis チャネル + 専用 2 本目 subscriber で multi-instance fan-out。self 抑止 + debounce + `revision.createdAt` 単調性ガードで冪等化。過去版 / draft は構造的に対象外（RFC-0003 §v2.1。spec: `feature-live-page-content-sync.md`）
- **閲覧中ページのコメントのライブ表示** — content-sync の姉妹機能。他者のコメント投稿/削除を閲覧中の一覧へフルリロードなしで反映（新着は数秒で消える amber ハイライト）。`/presence` チャネルに `comment-changed` を相乗り + `crowi:presence:comment-changed` Redis チャネルを content-sync の 2 本目 subscriber に相乗り subscribe（新規 client を増やさない）。payload は identity のみ（本文は権限チェック済み `GET /comments?page_id=` から再取得・非公開コメント本文は WS に載らない）。added のみ `actorUserId===selfUserId` で self 抑止 / removed は常に refetch（冪等）。新着ハイライトは client の seen-set 差分で判定（二重配信に頑健）。過去版 / draft は構造的に対象外（spec: `feature-live-page-comment-sync.md`）
- **フェーズ1 ページ機能** — CRUD / list / portal / revision / bookmark / like / seen-by / comment / watch / trash / backlink / notification / user page / history
- **RFC-0001 Plugin Architecture** — plugin-api / PluginManager / storage(local,s3) / search(ES,OpenSearch) / schema-driven admin form
- **検索** — 全文検索 UI + admin 検索ステータス + ES / OpenSearch driver
- **認証 / アカウント** — login / register / installer / 招待受諾 / メール確認・変更 / パスワードリセット
- **RFC-0002 Renderer** — TOC / SSR HTML + Shiki / cache / wikilink migrator / PlantUML + emoji + KaTeX / mention
- **RFC-0003 Realtime collab** — Yjs/Hocuspocus api 同居 / wsToken / compaction / 20-user cap / multi-server redis
- **RFC-0004 Editor UX** — toast / draft status / autocomplete / attachment upload
- **RFC-0005 Presence** — live presence row / メタチップ行 / likers
- **RFC-0010 OAuth (Phase 1-4)** — scope 基盤 / PAT / Authorization Code + PKCE / Device grant
- **RFC-0011 MCP server** — 組み込み `/mcp`（read+write 13 tool）+ prompt-injection 緩和（untrusted 本文を nonce 区切り wrap / read-only PAT 既定。spec: `feature-mcp-prompt-injection-mitigation.md`）
- **管理画面（フェーズ4）** — app / security / auth / mail / share / storage / users + sensitive config 暗号化
- **monorepo restructure** — workspace protocol / catalog / `@crowi/tsconfig` / `@crowi/runner` / Dockerfile / changesets
- **エディタ / UI** — CodeMirror 6 + preview / 階層サイドバー / create-page モーダル / boot progress / 通知 WS invalidation
- **ダークモード** — next-themes / Shiki dual-theme / CodeMirror dark / `User.theme` 端末間同期
- **インフラ / 品質** — mongoose 6→8 / Biome + lefthook / turbo `^build` / bcrypt / i18n(paraglide)
- **legacy 除去（RFC-0006）** — Express routes/controllers/Swig views/ts-rest 層を全削除
- **web エラー画面 / 接続レジリエンス** — `apiV2Fetch` タイムアウト / error boundary / `ConnectionProvider`（spec: `feature-web-error-screens.md`）
- **エディタ collab 堅牢化** — save 楽観ロック + anti-shrink ガード + synced gate + 復旧バッファ + token-refresh seam + multi-instance WS_TOKEN_SECRET 厳格化（spec: `feature-editor-preview-reliability.md`）
- **画像表示属性（RFC-0015）** — Markdown 画像 `![alt](url){width= height= align= float=}` の bundled core transform（standalone は合成 figure・inline は width/height のみ）+ web 側 value-based 再検証 helper（raw-HTML 偽造 `data-crowi-image-*` を無力化）+ CodeMirror hover/focus affordance。`RENDERER_PIPELINE_VERSION` 0.7.0→0.8.0 bump 込み（spec: `feature-image-display-attributes.md`）
- **Plugin activate/registerRoutes の per-plugin 隔離** — 1 plugin の起動時 throw で boot 全体が落ちないよう activate ループ / `registerRoutes` ループを個別 try/catch で隔離。`PluginManager.getFailedPlugins()` + `GET /admin/plugins` の `status:'failed'`（admin UI に「起動失敗」バッジ）で可視化（design-audit-2026-07 finding: plugin-sdk-no-registration-isolation。spec: `feature-plugin-registration-isolation.md`）
- **Plugin `onInstall` の install-once 契約実装** — SDK ドキュメントが約束する「1回目の boot でのみ実行・冪等」を実装に反映。専用 Config namespace `plugin-installed`（`plugin-install-tracker.ts`）で永続化し、`onInstall` 成功後のみ記録・throw 時は次回 boot で自動リトライ（design-audit-2026-07 finding: plugin-sdk-oninstall-contract-mismatch。spec: `feature-plugin-oninstall-idempotency.md`）
- **grant 判定の query-time / in-memory 食い違い解消** — `visiblePageGrantOr` に creator 節を追加し `isGrantedFor` と同一ルールから導出、`updateGrant` が page.creator を `grantedUsers` から落とさないよう修正、`isGrantedFor` の membership 判定を `.equals()` 値比較に統一（design-audit-2026-07 finding: SEC-GRANT-DUAL-PREDICATE。spec: `feature-grant-predicate-unification.md`）
- **PluginContext の capability 縮小** — 全プラグインに無制限だった `ctx.crypto`（グローバル暗号鍵、他プラグイン/core の secret を復号可能）を `@crowi/plugin-api` から削除し、`ctx.model(name)` を `CrowiPlugin.modelAccess?: string[]` 宣言による allow-list に限定（未宣言モデルの要求は throw、宣言モデル名は起動時 `PluginManager.activate()` で実在検証）。一次プラグイン（search-elasticsearch/mongo/opensearch, slack）を実際に使用するモデル名（Page/Bookmark/User/Revision、全て read-only）の宣言に更新し、`GET /admin/plugins` で admin が監査可能に。`@crowi/plugin-api` は破壊的変更（major）（design-audit-2026-07 finding: plugin-sdk-unrestricted-context-capabilities。spec: `feature-plugin-capability-scoping.md`）
- **hot-reload 用 state-cell primitive** — `@crowi/plugin-api` に `StateCell<T>`（`get`/`withValue`/`set`+`dispose`）を追加し `PluginContext.state<T>(initial)` として公開。`PluginManager` がプラグイン名をキーに 1 個だけ保持し、activate 時と reconfigure 時の異なる `ctx` インスタンス間で同一 cell を共有。`plugin-storage-aws-s3`（S3Client）/ `plugin-mail-smtp`（Transporter）/ `plugin-search-elasticsearch`（ES Client）の module-scope 手書き state を置き換え、`reconfigure` で旧リソースを `dispose` 経由で明示 teardown（S3: `destroy()`、SMTP: `close()`、ES: `close()`）。ES の close はもはや fire-and-forget ではなく in-flight リクエスト解決後に遅延（design-audit-2026-07 finding: plugin-sdk-hand-rolled-state-ref-no-primitive。spec: `feature-plugin-state-cell-primitive.md`）
- **ページネーション UI の Pager 統合** — prev/next 型（`pagination.tsx`）・番号付き client 計算（`search-pager.tsx`）・番号付き server 計算（`users-table.tsx` の `UsersPager`）という3つの重複実装を単一の `<Pager>`（`components/ui/pager.tsx`、判別可能 union `mode:'numbered'|'prev-next'`）+ 共有レンジ計算 `lib/pager-range.ts`（`buildPageRange`/`computePagerWindow`）に統合。`pagination.tsx` のハードコード英語（`Page {n}`/`Previous`/`Next`）と `search-pager.tsx` の省略ボタン `aria-label`（`Page 1`/`Page {totalPages}`）を Paraglide 化（`common.pager.*`）。`AdminPagerSchema` の `pages[]`/`previousDots`/`nextDots` は wire 契約として維持しつつ web 側では未使用化し、レンジ計算をクライアント側 `buildPageRange` に一本化（design-audit-2026-07 finding: WEB-05。spec: `feature-unified-pager.md`）

---

## Notes（運用）

- main 直コミット（`commitStrategy: main-direct`）。push / PR は明示指示待ち
- 並行作業は `gw start <name>` → 完了後 `/integrate-worktree <name>`
- API は Hono、`/api/v2` prefix。contract 編集後は `pnpm --filter @crowi/api-contract build`
- state: `.feature-state/`（root、gitignore 済）
- format/lint: pre-commit で biome format、pre-push で `pnpm lint` + `check:openapi`

## Operator runbooks

詳細手順は `apps/crowi-site/content/docs/{ja,en}/operations/` を参照。

- **Realtime collab**: api 同居。`WS_TOKEN_SECRET` 全レプリカ同一、multi-instance は `REDIS_URL` 必須
- **Storage driver 切替**: `crowi-admin rebuild storage copy` → `crowi.config.json` 変更 → 再起動
- **AWS 認証情報**: `/admin/plugins?name=@crowi/plugin-aws` で設定
