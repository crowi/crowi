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
- [x] Slack plugin Phase 0/1 完成（unfurl まで。spec: `feature-slack-plugin.md`）。残: Phase 2 slash+write（RFC-0014 連動）/ Phase 3 notifier / Phase E embed
- [ ] Step 10: auth provider plugin 化（OAuth。alpha1 で削除、将来 plugin で復活）
- [ ] 将来: encryption KeyProvider plugin (KMS)、S3 以外の attachment storage

### OAuth 2.0 (RFC-0010)
- [ ] Phase 5: admin による任意 OAuth クライアント登録 UI（Phase 1-4 完了）

### iOS ネイティブアプリ (RFC-0016)
- [x] Phase 0 companion server 側変更: trusted first-party `crowi-ios` OAuth client の server seed + custom-scheme redirect 緩和 + consent-skip 配線 + `GET /oauth/client-info`（spec: `feature-ios-companion-server.md`）。Apple 側 (apps/apple scaffold + gate 判定) は worktree `feature-ios-app` で進行中
- [x] renderedAst の client 非依存化 Phase 2 (RFC-0023 サーバ + web): sidecar プロデューサ + `X-Crowi-Ast-Version` negotiation + sanitizing walker + artifactKey + `rebuild rendered-ast` backfill。Phase 4-5 (iOS ネイティブ描画) は worktree `feature-ios-app` 側で消費
- [x] renderedAst golden corpus Phase 3 (RFC-0023): 二者消費 (api jest + CrowiKit XCTest) 前提の自己記述 JSON corpus で renderer 出力を固定し、GFM 参照系の挙動も確定。Swift 側の実読込は Phase 4 (worktree `feature-ios-app`) で接続

### 配布 / リリース（2.0.0 stable 時）
- [ ] **無印 `crowi` パッケージの整理**（spec: `feature-crowi-quickstart-package.md`）
- [ ] **slim image + 外部 operator 向け doc** — runner-project 方式。blocked-on `feature-plugin-search-mongo`

### 管理画面 残（フェーズ4）
- [ ] Slack channel 通知（page-path→channel mapping + Slack 統合設定）

### その他 残作業
- [ ] error code 細分化（comment/revision の `INVALID_REQUEST`）
- [ ] web テスト基盤整備 + API coverage 強化
- [x] **並列 jest の DB 接続 flake 根治**（bounded retry + テスト専用 mongod 分離 + DB-bypass lint 強制 + collab・plugin-search-mongo の probe/drop 統一 + invariant assert + `pnpm test:flake` flake 自動検出）。spec: `feature-test-parallel-db-flake-hardening.md`
- [x] **残存テスト flake の計測基盤 + baseline taxonomy 確立**（親プロセス reporter で worker crash 含め権威記録。観測 class: ephemeral-port timeout・401 不整合・E11000・SIGSEGV、remedy は class ごと別 spec へ）。spec: `feature-flake-failure-taxonomy.md`
- [x] **flake-report を本番 test job の結果から分類するよう再設計**（独立フル実行を廃止し producer/consumer + run-ID 相関の artifact 契約に。FLAKY/REGRESSION/INCONCLUSIVE(INFRASTRUCTURE) の3状態化、api以外の失敗/artifact欠落/cancelを緑と誤表示しない provenance を summary+artifact に明記）。spec: `feature-flake-report-detection-redesign.md`
- [x] **flake-report の検知結果を triage ループへ配線**（classify 後に GitHub issue 自動起票/occurrence 追記 + fork PR は annotation に degrade、orchestrate watcher に F レーン（NEW/UPDATED_FLAKY_ISSUE 検知・報告のみ）追加、任意で neutral check-run。non-blocking job で検知されても誰にも見られていなかった問題に対処）。spec: `feature-flake-report-triage-loop.md`
- [x] **collab lifecycle epoch で rename/delete 後のライブエディタを無効化**（RFC-0017 Phase 1、cross-replica prompt fanout は Phase 2 対象外）。spec: `feature-collab-invalidate-on-rename-delete.md`
- [x] **WS client reconnect primitive** — presence / notifications の WebSocket reconnect ロジックを共有 client primitive に抽出し、close code を一元化した（spec: `feature-ws-client-socket-primitive.md`）
- [x] **WS server attach primitive** — collab / presence / notifications の WebSocket upgrade-attach-shutdown 骨格を共有 server primitive (`attachWsNamespace`) に抽出した（spec: `feature-ws-namespace-attach-primitive.md`）
- [x] **presence の generic feed bus 化** — viewer-list/page-updated/comment-changed の手配線を generic subscribe/publish 抽象に統合し、Redis subscriber を2本→1本に集約した（spec: `feature-presence-generic-feed-bus.md`）
- [x] **presence token の proactive refetch churn 修正** — `usePresenceToken` の ~4.5 分ごとの無条件 `refetchInterval` を撤去し、`useYjsToken` の D1a パターン（`staleTime: Infinity` + 接続確立中はリフェッチしない）へ揃え、撤去で失われる 4401 リカバリを capped backoff 付き token invalidate で補った（spec: `feature-presence-token-churn-fix.md`）
- [x] **presence の一貫性欠陥4件修正** — マルチレプリカでの multi-tab 誤削除・viewers フレーム順序崩れ・ページ遷移時の前ページ viewer 混入・join 失敗時の永久 stale の4件を修正した（spec: `feature-presence-consistency-fixes.md`）
- [x] **モバイルページヘッダの live presence 専用カード化** — モバイルの `[👁 N]` チップを統計チップ直下の専用カード（重なりアバター+自然言語カウント+文字でも分かる接続状態）へ置き換え、`usePresence` に自動再試行中と terminal error の区別を追加した（spec: `feature-mobile-presence-card.md`）
- [x] **ページリンクのスペース処理を CommonMark 準拠 + 寛容復元に統一** — Phase 1: `+`/%2B 契約の統一強制・fragment/malformed-percent 堅牢化。Phase 2: 生スペース destination を内部リンクへ寛容復元、renderer 0.10.0（spec: `feature-page-link-space-paths.md`）
- [x] **プロフィール統計 (likes/comments) とワークスペースページ総数 API** — `GET /user/{username}` に本人が行った `likesCount`/`commentsCount` を追加、`GET /pages/list` の全分岐に閲覧者可視ページの正確な `total` を追加（iOS デザイン刷新向け API 拡張。UI 変更なし）。spec: `feature-profile-stats-and-page-total.md`

---

## バックログ（機能ロードマップ残 / dep major 待ち）

レビュー / simplify の advisory はここに積まない（**fix or drop** — 直すか捨てるかの二択。CLAUDE.md「Review findings: fix or drop」参照）。残すのは機能ロードマップ残と dep major 待ちのみ。

- [ ] **E2E coverage (point-by-point)**: page CRUD → editor save/draft → comments → search → notifications → admin の順で、新機能/バグ修正のついでに `packages/e2e` を拡充（一括タスクにしない。運用は e2eTargets — feature-planner.md 参照）
- [ ] **RFC-0002 renderer 残**（GitHub Embed plugin、mention N+1 ほか。`addEmbedTag` registry の最初の利用者は link-card で出荷済み — spec: `feature-link-card-embed.md`）
- [ ] **monorepo restructure follow-ups**（catalog 化、compose healthcheck、dev/prod parity ほか）
- [ ] **crypto Phase 3**（KeyProvider pluggable 化、lookup-key secret の hash 化）
- [ ] **RFC-0008 follow-ups**（`rebuild renderer`/`backlink` 本実装、watcher backfill 統一、RFC 追従）
- [ ] **eslint 8 → 9 major up**（`packages/api` / `packages/collab` の direct eslint 8.57.1。flat config 統一が主目的 — GHSA `js-yaml` advisory は eslint version と無関係に root `pnpm.overrides` の `js-yaml@>=3.0.0 <3.15.0` / `js-yaml@>=4.0.0 <4.3.0` で解消済み）
- [x] **mongoose 8 → 9 major up**（`packages/api` / `packages/collab` / `packages/plugin-search-mongo`。mongodb 6→7・mms 10→11 同伴。GHSA `ip-address` chain は mongoose major とは直交し、root `pnpm.overrides` の `"socks": "^2.8.7"` で解消）

---

## ✅ 完了済み（主なマイルストーン）

- **2.0.0-alpha.0 / .1 / .2 リリース** — 外部共有・ソーシャルログイン・通知設定の削除 + renameTree 移行 + version bump（spec: `feature-v2-alpha1-release-prep.md`）
- **v1→v2 データ移行（RFC-0008）** — migration framework + body-rewrite 群の修正 + preflight severity 分割（spec: `feature-migration-preflight-severity.md` ほか）
- **配布 / リリース基盤** — runner-project 方式 + web image の API URL 実行時注入 + CI リリース自動化（specs: `feature-prod-runner-project.md` / `feature-web-image-runtime-config.md` / `feature-ci-release-automation.md`）
- **特定 revision への revert** — stale 帯の「この版に戻す」+ `POST /pages/revert-to-revision` + MCP `crowi_revert_to_revision`（非破壊・portal 対応。spec: `feature-revision-revert.md`）
- **web auth state 集約（fugu-report P0-1）** — `useAuth` の React Query singleton 化 + reactive token store + `AuthSync` island（spec: `feature-web-auth-state-centralization.md`）
- **閲覧中ページのライブ差し替え（read-side soft-refresh）** — 他者保存を presence WS 相乗りでフルリロードなしに最新 revision へ反映（spec: `feature-live-page-content-sync.md`）
- **ページ閲覧のライブ反映 reconcile（push 取りこぼし補完）** — tab 復帰/再接続/4403 close/show-latest/周期バックストップの5トリガーで head-GET reconcile を追加し取りこぼしを解消。GET /pages の未知例外も 500 に分離（spec: `feature-live-page-sync-reconcile.md`）
- **閲覧中ページのコメントのライブ表示** — 他者のコメント投稿/削除を presence 相乗りで一覧へ反映（spec: `feature-live-page-comment-sync.md`）
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
- **画像表示属性（RFC-0015）** — Markdown 画像の `{width= height= align= float=}` 属性を core transform + web 再検証 + editor affordance で実装（spec: `feature-image-display-attributes.md`）
- **Plugin activate/registerRoutes の per-plugin 隔離** — 1 plugin の throw で boot 全体が落ちないよう隔離し、失敗 plugin を admin UI で可視化（spec: `feature-plugin-registration-isolation.md`）
- **Plugin `onInstall` の install-once 契約実装** — 専用 namespace に install 記録・throw 時は次回 boot でリトライ（spec: `feature-plugin-oninstall-idempotency.md`）
- **grant 判定の query-time / in-memory 食い違い解消** — 単一ルールから両述語を導出 + `updateGrant` の creator 落ち修正（spec: `feature-grant-predicate-unification.md`）
- **PluginContext の capability 縮小** — `ctx.crypto` 削除 + `ctx.model()` の `modelAccess` 宣言 allow-list 化（plugin-api major。spec: `feature-plugin-capability-scoping.md`）
- **hot-reload 用 state-cell primitive** — `StateCell<T>` を SDK に追加し S3/SMTP/ES driver の手書き state を置換、reconfigure で旧リソースを dispose（spec: `feature-plugin-state-cell-primitive.md`）
- **ページネーション UI の Pager 統合** — 3 重複実装を単一 `<Pager>` + `pager-range` に統合し文言を Paraglide 化（spec: `feature-unified-pager.md`）
- **中央 env 検証（boot 時に一括 validate）** — 散在した `process.env` 読取を `env-schema` + `validateEnv()` に一本化、fail-fast/warn/typo 検出を統一（spec: `feature-boot-env-validation.md`）
- **Plugin capability hardening** — credential-vault モデルの `modelAccess` deny-list + `dependencyConfig` の依存側 opt-in 化で SDK トラスト境界の主張を真にする（plugin-api major。spec: `feature-plugin-capability-hardening.md`）
- **`/app/info` capabilities の enum 化** — `capabilities`/`apiVersion` を known vocabulary の enum + named const 参照へ型付けし CLI 連携のズレを compile check 化（spec: `feature-app-info-capabilities-typed.md`）
- **GRANT_RESTRICTED 共有バナー + grant-on-first-access** — 専用エンドポイント `POST /pages/link-access` によるリンク初回アクセス時招待 + 実挙動を正直に伝える常設共有バナー UI（spec: `feature-restricted-grant-share-banner.md`）
- **ページ系 react-query queryKey レジストリ統合** — save 後の portal-staleness 再発防止に、page/list/children/revisions/user-page の queryKey を単一 `page-query-keys.ts` に集約（spec: `feature-page-cache-key-registry.md`）
- **アプリシェルの a11y 基盤(skip-link + ルート遷移フォーカス管理 + mobile-search の Sheet 化)** — (auth)/(admin) 両 layout に skip-link + `use-route-focus` フックを追加、mobile-search.tsx の手製 `createPortal` オーバーレイを Radix Dialog ベースの `Sheet` に置換しフォーカストラップ/復元/Esc クローズ/scroll lock を委譲（spec: `feature-app-shell-a11y.md`）
- **boot 手順の宣言的ステップ定義への統一** — `runInitLayers`/`initForCli` の二重手書きステップ列挙を `boot-steps.ts` の `ALL_BOOT_STEPS` + `resolveBootOrder()`（`topoSortPlugins` の DFS を踏襲）に統一し、CLI 省略対象を `CLI_SKIP_STEPS` 一箇所に集約（spec: `feature-boot-sequence-declarative.md`）
- **モバイル共有メニューの URL コピー修正** — page-actions-menu の「URLをコピー」項目を PC と共通の `SharePanelContent` 共有ダイアログに統一し、auto-copy + タイトル/Markdown 行を提供（spec: `feature-mobile-share-menu-fix.md`）
- **ユーザーページに「配下ページ (Subpages)」タブを追加** — `/user/<username>/` 配下を path 起点で全階層再帰的に一覧表示する専用 endpoint + static + UI を新設（既存の creator 起点「作成したページ」タブとは別次元）。付随して draft 作成失敗時の孤児 Page hardening を同梱（spec: `feature-user-page-subpages-tab.md`）
- **URL カード埋め込み `@[card](url)`** — `addEmbedTag` registry の最初の利用者として `@crowi/plugin-renderer-link-card`（SSRF ガード付き OGP fetch）を実装 + editor に裸 URL ⇔ `@[card](url)` 変換 affordance を追加。後に `@crowi/api` core へ統合され plugin package は削除済み（下記「Renderer plugin 境界の確立」参照。spec: `feature-link-card-embed.md`）
- **Revision に不変の page ObjectId 参照を追加(DC-5)** — `path` 文字列の逆引きに依存していた rename 後の履歴解決 / 削除 / 著者集計を、`prepareRevision` で一度だけ刻む不変の `revision.page` id 参照へ切り替え。path 再利用による誤った grant 解決の latent bug を是正し、boot migration `revision-page-ref-backfill` で既存データをバックフィル（spec: `feature-revision-page-ref.md`）
- **Renderer plugin 境界の確立 + emoji/link-card の core 統合** — presentation/asset contract の一般化 + KaTeX 自己配信 + emoji・link-card の `@crowi/api` core 統合(admin egress toggle 付き) + 旧 plugin package 削除（spec: `feature-renderer-plugin-boundary.md`）
- **svg-sanitize を非公開の内部共有 lib 化** — `@crowi/plugin-renderer-svg-sanitize` を private 化して `@crowi/svg-sanitize` にリネームし、plugin 名前空間から外して mermaid/plantuml に bundle する方式へ変更（spec: `feature-svg-sanitize-private-bundled.md`）
- **`/pages/children` にセグメントの更新メタデータを追加** — `PageChildSegment` に `lastUpdatedAt`/`updater` を additive 追加し、`findChildSegments` の既存走査内で代表ページ（`isPage` ならページ自身、それ以外は配下最新更新ページ）を導出。grant/status 可視性の内側のみで選定し N+1 も増やさない（iOS 側 UI は別 spec で消費。spec: `feature-child-segments-metadata.md`）

---

## Notes（運用）

- main 直コミット（`commitStrategy: main-direct`）。push / PR は明示指示待ち
- 並行作業は `gw start <name>` → 完了後 `/integrate-worktree <name>`
- API は Hono、`/api` prefix。contract 編集後は `pnpm --filter @crowi/api-contract build`
- state: `.feature-state/`（root、gitignore 済）
- format/lint: pre-commit で biome format、pre-push で `pnpm lint` + `check:openapi`

## Operator runbooks

詳細手順は `apps/crowi-site/content/docs/{ja,en}/operations/` を参照。

- **Realtime collab**: api 同居。`WS_TOKEN_SECRET` 全レプリカ同一、multi-instance は `REDIS_URL` 必須
- **Storage driver 切替**: `crowi-admin rebuild storage copy` → `crowi.config.json` 変更 → 再起動
- **AWS 認証情報**: `/admin/plugins?name=@crowi/plugin-aws` で設定
