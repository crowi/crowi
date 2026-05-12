# TODO List

Crowi 2.0 移行 (Express + Swig → Next.js + ts-rest)。フェーズ別。
ロードマップの詳細は project memory (`migration_roadmap.md`) を参照。

## High Priority — フェーズ 1 残 (ページ機能の完成)

🎉 **フェーズ 1 完了** — Trash / page watch / Seen by 改善まで反映済み。
詳細は「Recently Completed (このセッション)」を参照。

## High Priority — Plugin Architecture (RFC-0001)

`docs/rfcs/0001-plugin-architecture.md` 進行中。Step 7 (admin UI) まで landing 済み、後続ステップが残る。

- [x] **plugin-api パッケージ** — type-only contract (`CrowiPlugin`, `PluginContext`, `*Registry`, `@sensitive` / `@action` Zod markers, `adminPlacement`)
- [x] **PluginManager + 自動依存解決** — boot 時 topo sort、transitive auto-load、storage / search / auth / notifier registries
- [x] **`@crowi/storage-local` (default-on)** + **`@crowi/aws` (base/config-only) + `@crowi/storage-aws-s3`** — storage driver の plugin 化
- [x] **Step 7: schema-driven admin form** — `/admin/plugins` 一覧 + `/admin/plugins/edit?name=...` 編集 (auto-form、kind ベース control 選択、sensitive は `hasValue` のみ往復、@action ボタン)
- [x] **plugin-driven sidebar 注入** (`a092cd8f`) — `adminPlacement` に section / label / icon、サイドバーが loaded plugin から該当セクション (storage / mail / notification / auth / shared) に entry を inject
- [ ] **Step 8: notifier plugin 化** — Slack notifier を plugin に切り出し (現在 `util/slack.ts` に直書き)
- [ ] **Step 9: search driver plugin 化** — Elasticsearch を plugin 化 (Phase 3 の ES 復活と合わせて)
- [ ] **Step 10: auth provider plugin 化** — Google / GitHub OAuth を plugin に切り出し (フェーズ 4 の admin OAuth 設定と一緒に)
- [ ] **将来**: encryption KeyProvider plugin (KMS 系)、attachment storage の S3 以外プロバイダ

## High Priority — 横断的 advisory (累積)

- [x] **UI 共通化** (`2c390a55`): `LoadingSpinner` / `ErrorAlert` / `AccessDeniedCard` / `NotFoundCard` を `apps/crowi-web/src/components/ui/` に抽出。9 ファイル / 13 サイトで重複削減
- [x] **i18n 戦略確立 + 主要 surface 移行** (`3c0e7432` + `8a47e65d` + `b6aa27bc`): paraglide-js 採用、page-view / list / history / comments / user-page / edit / admin (`admin.common.*`)、me 配下を全 i18n 化。残: rename-dialog の `'編集が競合しました'` ハードコード、use-bookmark / use-watch / use-notifications / use-like / use-user-page の `'Authentication required'` を既存の `errors.auth_required` に集約 (small advisory)
- [x] **`req.user` の Express type augmentation** (`8e8524ac`): `packages/api/src/types/express.ts` で global 拡張、35 サイトの cast を撲滅
- [x] **`pageToResponse` / `toPageUser` / `toUserPublic` / `isPopulatedUser` の統一** (`6c43ef77` + `8b2fe70f`):
  - `toUserPublic` を util に統合 (`PopulatedUserPublic` 経由で fallback 対応)
  - `isPopulatedUser` を util に集約 (loose triplet 判定)
  - `pageNotFoundResponse` / `invalidPageIdResponse` を util の const に
  - `pageToResponse` の date 系を fallback (createdAt/updatedAt が undefined でも schema を満たす) に
- [x] **`loadGrantedPage` を util に格上げ** (`0f988d3e`): `PageModelLike` 経由で page / bookmark / comment / notification / revision から呼べるように昇格

## Medium Priority — フェーズ 2 残 / 周辺機能

- [x] **Backlinks** (`0213c1bf` event wiring → `786925aa` Web 一覧 → `56c48976` simplify): `/api/v2/backlinks` ts-rest、page-view footer に `<BacklinkList>` (createBySavedPage は bulk insert 化済 — 4 round-trips)
- [ ] **残りの認証 routes**:
  - `GET /login/google` / `GET /login/github` / 各 callback
  - `GET /login/invited` / `POST /login/activateInvited`
- [ ] **残り middleware の JSON 化**:
  - `adminRequired` / `applicationNotInstalled` / `fileAccessRightOrLoginRequired`
- [ ] **error code 細分化**: comment.ts / revision.ts などの `INVALID_REQUEST` を `MISSING_REQUIRED_FIELD` / `INVALID_OBJECT_ID` / `*_FAILED` に分割
- [x] **`usePageComments` を 3 hooks に split** (`8d6b695c`): 11 fields 返す巨大 hook を `usePageCommentsList` / `useAddComment` / `useDeleteComment` に分割
- [x] **`Backlink.createBySavedPage` を bulk insert 化** (`4f12a8c9`): `deleteMany` → N×`isExist*` → N×`Backlink.create()` を `deleteMany` → 2×`Page.find($in)` → 1×`insertMany` に。1+2K round-trips → 4 round-trips。`createByAllPages` も同パターンで修正、dedupe を Set ベースに(O(N²)→O(N))
- [x] **`unwrapResult(result, ...)` ts-rest helper を抽出** (`5913f93d`): `lib/unwrap-result.ts` に lift、12 hook ファイル(use-page-mutations / bookmark / watch / like / page-list / page-comments / notifications / page-revisions / user-page / profile / admin-users / admin-crypto)を migrate。`SuccessBody<R>` で ts-rest の 200 body 型を抽出、`wireMessage` は `body.error.message` と `body.message` の両 envelope に対応。skip した 5 ファイル(use-page / backlinks / seen / admin-{app,mail}-settings)は inline の方が簡潔/特殊形のため
- [x] **admin config coercion helper の共通化** (`37b35eda`): `coerceBoolean` / `coerceString` / `coerceNumber` / `coerceStringArray` + `getCrowiConfigNamespace` を `util/admin-config.ts` に集約、5 admin handler を migrate
- [x] **`internalServerErrorResponse` const helper** (`06392ac4`): `util/ts-rest-helpers.ts` に `as const` で抽出、6+ 重複を解消
- [x] **admin 共通 i18n キー** (`b6aa27bc`): byte-identical な 12 キーを `admin.common.*` に集約 (5 namespace 横断)
- [x] **admin settings: 変更なし時の PUT skip** (`471998f0`): auth-form / security-form に `isDirty` guard 追加 (app/mail/share は既に実装済)
- [x] **`createAdminSettingsHooks<T>` factory** (`d45d9bb9`): share / auth / security の 3 hook を `lib/admin-settings-factory.ts` に集約。app / mail は別シェイプなので未対象
- [x] **`<SecretField>` コンポーネント抽出** (`85c8fe59`): app / mail の secret block 3 箇所を `components/admin/secret-field.tsx` に集約
- [x] **AWS schema 重複** (`41d7b313`): `schemas/admin/_aws.ts` に lift、両 schema が import
- [x] **`createPager` を util に格上げ** (`fcce4390`): `util/admin-pager.ts` + `schemas/admin/_pager.ts` に抽出
- [x] **`User.findUsersWithPagination` の projection** (`9fa5433c`): `select('-password -apiToken -googleId -githubId')` で機密フィールドを Mongo 段で落とす。同時に sort も復活 (legacy の 4 引数指定は v5 で silently 無視されていた)
- [x] **`UserPublicSchema.status` を enum に絞る** (`2d0c695f`): `UserPublicStatus` を `z.nativeEnum` で型付け、`UserStatusEnum` は backward-compat re-export
- [x] **`paginate: any` を型付け** (`0bce9def`): `PaginateResult<T>` / `PaginateOptions` 定義、handler は `User.paginate(...)` を直接呼ぶ Promise 形式に

## Medium Priority — フェーズ 3 (検索 / アセット)

- [ ] **検索画面**: `/_search` / `/_api/search`
- [ ] **Elasticsearch 復活** (現在 docker-compose から外し中、バージョン更新込み)
- [x] **Attachments**: `attachments.list` / `attachments.add` / `attachments.remove` — ts-rest 化 (`/api/v2/pages/:pageId/attachments` + `/api/v2/attachments/:id`)、生 Express で stream delivery (`GET /api/v2/attachments/:id` / `GET /api/v2/attachments/by-key/:key` whitelist `user/`)、`/files/:id` は 302 redirect、`Attachment.fileUrl` virtual と `fileUploader.generateUrl` を新ルートに揃え、profile picture round-trip も復活。Web 側は `useAttachments` + `<AttachmentList>` を page-view footer に embed (画像は inline preview / 他は download link)。
  - 意味論変更: `attachments.add` の暗黙 page 作成 (`page_id=0` + path) は廃止 (フロントエンドが createPage → addAttachment の 2 step に分割する想定)
  - 意味論変更: `attachments.remove` の権限を `creator OR admin OR page.grantedUsers` に絞る (legacy は誰でも削除可だった)
  - フォローアップ別タスクに送ったもの: drag-and-drop / inline 画像挿入 (page-edit UI)、Share 経由 anonymous attachment view、サーバ側 MIME / size 強制、user.image legacy URL のマイグレーションスクリプト、attachment list pagination

## Low Priority — フェーズ 4 (管理画面、重い)

旧実装の管理画面 React は Phase 1 で削除済み。API endpoints だけ
`packages/api/src/routes/api/admin.ts` に残っているので、ts-rest 化 + Next.js 管理
画面 (`apps/crowi-web/src/app/(admin)/`) を新設する。

### 基盤
- [x] **adminRequired middleware を JSON 化** (Medium Priority に既出、依存) — 8abd0c8f
- [x] **`/admin` index** + Admin layout (sidebar / breadcrumb) — 5123e06d
- [x] Next.js Route Group `(admin)` 設計、admin 専用認可 (User.admin === true) — 5123e06d

### 設定 (Config model に集約、各セクションで部分更新)
- [x] **App** (`GET/PUT /admin/app`): サイト名 / 機密情報の注意書き。AWS S3 認証情報は `/admin/plugins?name=@crowi/plugin-aws` に移行済(下記 Storage 参照)
- [x] **Security** (`GET/PUT /admin/security`): basic 認証 / registrationMode / registrationWhiteList
- [x] **Authentication** (`GET/PUT /admin/auth`): requireThirdPartyAuth / disablePasswordAuth + 自分自身のロックアウト防止 (422)
- [x] **Mail / SMTP** (`GET/PUT /admin/mail` + `POST /admin/mail/test`): from / SMTP host / port / user / password + AWS SES + テスト送信
- [x] **Share** (`GET/PUT /admin/share`): 外部共有 link の有効/無効 toggle + 旧 form/route 削除
- [x] **Storage** (`GET /admin/storage`): active driver + インストール済 driver 一覧 (read-only)。driver 切替は `crowi.config.json:storage.driver` + 再起動。ファイル移行は `crowi-admin storage copy --from <a> --to <b>` (新設の `@crowi/admin-cli` パッケージ)。boot 時に旧 `upload:aws:*` → `plugin:@crowi/plugin-aws:*` を 1-shot copy(新キーが空のときのみ、rollback のため旧キーは温存)
- [ ] **Google OAuth** (`POST /admin/settings/google`): clientId / secret
- [ ] **GitHub OAuth** (`POST /admin/settings/github`): clientId / secret / org
- ~~AWS / S3 file storage~~: `/admin/storage` + `/admin/plugins?name=@crowi/plugin-aws` に分離(`/admin/app` の upload section は廃止)

### ユーザー管理
- [x] **User 一覧** (`GET /admin/users`) + 検索 (`GET /admin/users.search`) — `0223d46b` + `8316d50a` + `7820711c`: ts-rest contract / API ハンドラ (createPager 移植 + UserPublic 絞込み) / Web 画面 (URL state 同期 + debounce 検索 + numbered pager)。
- [x] **招待 / 編集 / 権限 / 状態 / パスワードリセット / メール変更** (`49f5f211` + simplify `d63d9457`) — 6 アクションを 1 PR にまとめて統合。`<UserActionDialogs>` (Invite / Edit / UpdateEmail / ResetPasswordResult / ConfirmAction) + dropdown menu。i18n / EmailConflictError / unwrapResult 経由
- [x] **users table 情報整理** (`e77a1690`) — 3 列 (User/Username/Email) を 1 列に統合、chip の `whitespace-nowrap` で改行解消、role badge は customized のみ表示

### 通知 (Page → Slack channel)
- [ ] **通知一覧 / 編集** (`GET /admin/notification`)
- [ ] **page-path → channel mapping**
  - 追加: `POST /admin/notification.add`
  - 削除: `POST /admin/notification.remove`
- [ ] **Slack 統合設定** (incoming webhook + 認証情報)
  - 追加: `POST /admin/notification/slackSetting.add`
  - 削除: `POST /admin/notification/slackSetting.remove`
  - Slack OAuth callback: `GET /admin/notification/slackAuth`

### メンテナンス操作
- [ ] **Elasticsearch インデックス再構築** (`POST /admin/search/build`) — フェーズ 3 の ES 復活が前提
- [ ] **バックリンク再構築** (`POST /admin/backlink/build`) — 全ページ走査して link 関係を再計算

### 旧実装の参照
- API endpoints: `packages/api/src/routes/api/admin.ts`
- Express ルート (legacy GET, SPA index 返し): `packages/api/src/routes/admin.ts`
- Controller: `packages/api/src/controllers/admin.ts`
- Form validators: `packages/api/src/form/admin/*`
- 旧 Swig views は **既に削除済み** (Phase 1 で React/views クリア時に)

## Low Priority — フェーズ 5 (共有 / OAuth / 招待)

- [ ] Shares CRUD + secretKeyword
- [ ] Slack event endpoint (受信側、`/_api/slack/event`)
- [ ] 招待ログイン (`invited` / `activateInvited`)

## Low Priority — クリーンアップ

- [ ] 旧 Express routes / controllers の除去 (ts-rest 移行完了後)
- [ ] 旧 Swig views の削除
- [ ] `packages/api/src/util/apiResponse.ts` (legacy) の整理
- [ ] テスト整備 (web 側のテスト基盤、API の coverage 強化)
- [ ] エディタ強化 (Markdown プレビュー / リッチエディタ / 自動保存 / 画像アップロード)

## Recently Completed (このセッション)

### RFC-0002 Renderer Plugin Architecture
- [x] **Phase 1 — TOC + stale-revision detection** (`f38ea56a` + simplify `15dda424`) — `Page.metadata.toc` の永続化 (regex extractor + Slugger) と revision_id ベースの stale-edit detection。client は `meta.toc` の anchorId を heading に stamp して anchor 同期を保つ
- [x] **Phase 2 — renderer pipeline 基盤 + metadata 拡張** — `@crowi/plugin-api` に `RendererRegistry` / `NodeRenderer` / `CodeBlockRenderer` / `EmbedRenderer` / `UrlInlineExpansionRule` / `RenderContext` 型を追加 + `CrowiPlugin.registerRenderer?` 拡張ポイント。api 側に unified.js ベースの parse → transform pipeline (`apps/crowi-api/src/renderer/`) を新規導入し、core 4 transform (TOC via github-slugger / wikilinks / mentions / codeBlockLanguages) を bundled 配置。`Revision.meta` に `wikiLinks` / `mentions` / `codeBlockLanguages` を追加して `prepareRevision` で persist、`pageToResponse` の on-the-fly fallback も extend (`computeRevisionMetaAsync`)。Phase 1 の regex extractToc / Slugger は削除。Web は `remarkWikiLink` + `remarkMention` plugin を独立に追加して `[[…]]` / `@username` を link 化 (broken は `wikilink-broken`、mention は primary color)。ESM-only な unified.js を CJS Express から呼ぶために `jiti` 経由で sync `require`-of-ESM (jest の `--experimental-vm-modules` は使わない)。`addEmbedTag` / `addUrlInlineExpander` / `addCodeBlockRenderer` は interface のみ expose、impl は warn-noop (Phase 3 で実装)
- [x] **Phase 3 — SSR HTML 化 (transformed MDAST 永続化) + Shiki syntax highlight** — server pipeline に bundled core plugin を 1 個追加 (`syntax-highlight`、shiki `github-light` で `code` ブロックを highlight して `html` ノードに置換)、core 順は headings → wikilinks → mentions → code-blocks → syntax-highlight。`runRender(body)` を `Renderer` interface に追加し、`prepareRevision` で transformed mdast を `serializeMdast` 経由で `Revision.renderedAst` (Mixed) に persist。`RevisionSchema.renderedAst: z.unknown().optional()` を contract に追加、`pageToResponse` / `revisionToFullResponse` に `withRenderedAst` gate (default false、detail endpoint のみ true)、Phase 2 の on-the-fly fallback を `computeRevisionRenderedAstAsync` で複製。Web は `react-markdown` + `remark-gfm` + `remark-mention` + `remark-wikilink` + `buildRemarkHeadingIds` を全削除し、`mdast-util-to-hast` + `hast-util-to-jsx-runtime` で `revision.renderedAst` から直接 React tree を構築 (parse + plugin chain がクライアント側に二重実装されていた状態を解消、Phase 2 simplify advisory R2/Q4)。section-wrap (URL hash 対応の `<section data-section-id>`) は server 側に移植せず web 側に小さな hast walker として残した — mdast に `section` 型がなく persisted shape が複雑になるため、UI 専属の振る舞いとして AST source of truth から切り離した。`useState`+`useEffect` の hash bridge は React 19 `set-state-in-effect` rule に当たったので `useSyncExternalStore` で URL を single source of truth に。shiki cold-load は jiti でできた warmup batch は Phase 4 へ寄せる
- [x] **Phase 4 — Reservation API + cache contract + plugin dispatch** — `@crowi/plugin-api` に `CacheStorage` / `ScopedCacheStorage` / `Reservation` / `RenderResult` / `RenderError` / `AuthContext` 型を確定。api 側に `PluginRenderCache` Mongoose model (TTL + compound unique index) + `MongoCacheStorage` + per-plugin scope + `sha256` embedKey helper を追加。`runPipeline` に dispatch layer (`@[tag](url)` embed-tag + bare-URL inline expand) を組込み、cache miss → render → set / hit → reuse の SWR (stale-while-revalidate) 経路を実装。`RendererRegistryImpl` の `addEmbedTag` (last-wins + 衝突 boot warn) / `addUrlInlineExpander` (登録順 list) を warn-noop から live impl に昇格。`AuthContext` は Phase 7 まで stub (config() throw)。Admin UI に `/admin/plugins/render-cache/clear-{all,plugin}` の AlertDialog + tanstack mutation。Cache invalidation triggers: pageEvent (`update`/`delete`/`rename`) と PluginManager.deactivate に listener。Echo-embed fixture plugin で end-to-end (parse → cache miss → render → cache set → re-parse hits cache) を test
- [x] **Phase 5 — crowi-legacy plugin + wikilink migrator** — `packages/plugin-renderer-crowi-legacy/` を新規追加 (`@crowi/plugin-renderer-crowi-legacy`, version `0.1.0-dev`)、`registerRenderer` で `remark-breaks` を transform phase に登録 (v1 単一改行 → `<br>` 互換、他の v1 quirks は Phase 5.1+ advisory)。`remark-breaks@4` は ESM-only なので Phase 2 の jiti pattern を踏襲。default は OFF (fresh install)、operator が `crowi.config.json:plugins` に追加して opt-in。`crowi-admin migrate --only=wikilink [--dry-run]` を追加 (`packages/admin-cli/src/commands/migrate-wikilink.ts`)、v1 angle-bracket internal link `</path/to/page>` を `[[/path/to/page]]` (Phase 2 wikilink syntax) に一括書き換え。検出 regex は `<(\/[^\s<>|]+)(\|[^<>]+)?>` で 1st segment が KNOWN_HTML_ELEMENTS (HTML5 全要素 + h1..h6) と一致する場合は reject (case-sensitive: lowercase ASCII のみ HTML 扱い、`</Section>` のような大文字始まりは wikilink 扱い)。per-page 処理 (1 page = 1 try/catch、失敗しても次に進む)、`Revision.prepareRevision` + `Page.pushRevision` + `pageEvent.emit('update')` で normal update path に乗せる (backlinks / search re-index / renderedAst も自動再生成)。author user は `CROWI_MIGRATE_USER=<email>` env 優先、なければ最古 admin user fallback。100 件ごとに progress log、最後に summary block (scanned / rewrote / failed / elapsed)。dry-run では 5 件まで sample (page path + 各 page の最初の 5 occurrence)
- [x] **Phase 8 — mention notifier dispatch** — Phase 2 で抽出済の `Revision.meta.mentions[]` を save event トリガに consume する dispatcher を `apps/crowi-api/src/events/mention-dispatch.ts` で新設、`pageEvent('update')` listener として fire-and-forget で動く (Phase 4 render-cache invalidation と同非同期パターン、save transaction 外側)。前 revision (path 同一・createdAt 降順で skip 1) の mentions[] と diff を取り、新規 username のみ通知 — 同じページを再保存しても重複通知は出ない。`util/activityDefine.ts` に `ACTION_MENTION = 'MENTION'` 追加、`models/activity.ts` に `createByPageMention(page, mentionedUser, author)` static method + **post('save') hook で MENTION skip ガード** (mentioned user は 1 人なので watchers fan-out 経路には乗せない、dispatcher が `Notification.upsertByActivity(mentionedUser._id, activity)` を直接呼ぶ)。Self-mention / `STATUS_ACTIVE` 以外 / 未登録 username は skip + warn (RFC open question #1 "render but don't notify, log warning" に整合)。`Notification.upsertByActivity` に notifier registry forward 経路を追加 (`crowi.pluginRegistries.active.notifiers[].send(payload)` を fire-and-forget per driver) — Phase 4 で interface のみ landed していた forward 配線が完成、Slack / Webhook notifier plugin が plug-in しただけで動く状態に。`packages/api-contract/src/schemas/notification.ts` の `NotificationActionSchema` を `z.enum(['COMMENT', 'LIKE', 'MENTION'])` に拡張、web `lib/notification-format.ts` の actionLabel 分岐に MENTION 追加 (exhaustiveness check) + `messages/{ja,en}.json` に `notifications.action_mention` key (`'メンション'` / `'mentioned you in'`、既存 message templates 流用)。Activity unit test (createByPageMention upsert + post-save MENTION skip) + dispatcher e2e (diff / self-skip / inactive-skip / unknown-username-skip / fixture notifier forward / fire-and-forget tolerance) を追加。Permission check / @team / @all / autocomplete / mention 削除時の通知撤回 / per-user opt-out preference は out of scope (将来 RFC)
- [x] **Phase 6 — PlantUML / emoji / KaTeX bundled renderer plugins + `addCodeBlockRenderer` 実体化** — `packages/plugin-renderer-{plantuml,emoji,katex}/` を新規追加 (各 `0.1.0-dev`)。PlantUML は ` ```plantuml ` fence を operator-設定 PlantUML server に投げて SVG/PNG 化 (cache TTL 1h、`reservation: aspect 16/9`、minimal regex SVG sanitizer)。emoji は `remark-emoji` v5 で `:smile:` → 😄 (ESM-only deps を plugin 内 jiti loader で sync require、code-fence / inline-code skip、`accessible: true`)。KaTeX は `remark-math` v6 で `$inline$` / `$$display$$` を parse → `addNodeRenderer('math'|'inlineMath')` で `katex.renderToString` (CJS) を呼び in-place mutate → `<div class="katex-block">` / `<span class="katex-inline">` で wrap (`strict: 'ignore'` + `throwOnError: false` で malformed LaTeX が落ちない)。Phase 4 で warn-noop だった `addCodeBlockRenderer` を `RendererRegistryImpl` に live 化 (Map + last-wins + boot warn、`addEmbedTag` 同パターン)、`core/code-block-dispatch.ts` で async post-processor として `buildPluginDispatchPlugins` 末尾に追加 (CodeBlockRenderer → EmbedRenderer adaptor 経由で `cachedRender` 共通経路に乗せる)。`packages/plugin-api/src/renderer.ts` の `CodeBlockRenderer` interface に `cacheVersion` (必須) / `reservation?` / `computeEmbedKey?` を追加 (non-breaking — Phase 4 で実装者ゼロ)。`apps/crowi-web/src/app/globals.css` に `@import 'katex/dist/katex.min.css'`、`apps/crowi-web/package.json` に `katex` dep 追加。dev-runner `crowi.config.json` で 3 plugin を default ON 化、`apps/crowi-api/package.json` devDeps に 3 workspace deps 追加して e2e (`__fixtures__/{plantuml,emoji,katex}.e2e.test.ts`) を整備
- [ ] **Phase 6.1+** — Mermaid renderer plugin (` ```mermaid ` を SSR、jsdom / puppeteer 系の heavy dep が要るので Phase 6 から切り離し)、PlantUML SVG sanitizer を DOMPurify に置換 (`isomorphic-dompurify` ~500KB、現案は minimal regex)、PlantUML PNG → SVG auto-fallback (SVG 404 → PNG 再試行)
- [ ] **Phase 8.1 — pageEvent payload enrichment (advisory)** — `models/page.ts:925-946` の `pageEvent.emit('create'|'update', ...)` で渡す pageData は emit 時点で revision が populate されていない経路がある (特に rename 経路 `page.ts:1099`)。結果 4 listeners (`search-index` / `mention-dispatch` / `backlinks` / `render-cache`) がそれぞれ `Page.findById().populate('revision')` を独立に発火 → save 1 件で 4× Mongo round-trip。さらに `Backlink.createBySavedPage` (`backlink.ts:117-124`) は `savedPage.revision.body` 前提なので rename 経路で silently throws (`events/page.ts:registerBacklinks` の try/catch で握り潰され、backlink が更新されない latent bug)。`Page.populatePageData` を emit 直前に呼ぶ / または emit ヘルパで 1 度だけ populate して全 listener に共有 payload を流す形にする
- [ ] **Phase 8.2 — mention dispatch N+1 (advisory)** — `events/mention-dispatch.ts:127-149` が `newUsernames` を `await` ループで処理 → 100 mentions の page で `User.findOne` × 100 + `Activity.create` × 100 + `Notification.upsertByActivity` × 100 のシリアル round-trip。`User.find({ username: { $in: newUsernames }, status: ACTIVE })` で 1 query に集約 + `Promise.all` で並列化すると wall-clock が N×RTT → ~2×RTT になる
- [ ] **Phase 3.1 — Revision.renderedAst size cap (advisory)** — `models/revision.ts:124-127, 197-200` の `renderedAst` は `Schema.Types.Mixed` で全 save 時に永続化、shiki トークンツリーが含まれるため 巨大コードブロックを多数含む page で Mongoose 16MB 上限に当たる可能性がある。対策案: (a) `body.length` 閾値超過時のみ persist (小さい body は on-the-fly 再パース で十分速い) (b) serialize 後サイズが 256KB 超なら persist せず on-the-fly fallback に任せる (`mongodb-cache.ts:103-109` と同方式)
- [ ] **Phase 7+** — GitHub Embed plugin + `AuthContext` 本実装 (encrypted-config-backed lookup、Phase 4 stub は throw)、admin-controlled lazy loading of katex.min.css (`<link rel="preload">` per-plugin opt-in)、per-plugin admin UI 拡張 (個別 config form、Phase 6 は共通 schema-driven form)、外部 plugin の core 前後挿入、shiki theme 切替 (light/dark)、`crowi-admin renderer:rebuild` (既存 revision の AST 一括再生成バッチ)、`@crowi/plugin-renderer-crowi-legacy` の configSchema 分割

### Monorepo packages restructure (publish-ready 化、`feature-monorepo-packages-restructure`)
- [x] **Phase 1 — workspace: プロトコル徹底** — 全 packages 間依存を `workspace:^` (runtime deps) / `workspace:*` (devDeps) に統一。`apps/crowi-api/package.json` devDeps 6 件 (plugin-renderer-{crowi-legacy,emoji,katex,plantuml} / plugin-storage-{aws-s3,local}) を `workspace:^` → `workspace:*`、`apps/crowi-web/package.json` deps の `@crowi/api-contract` を `workspace:*` → `workspace:^` に修正 (本来 runtime dep なので caret 側が正)。`pnpm pack` で `workspace:^` → `^x.y.z` / `workspace:*` → `x.y.z` の rewrite を実機確認 (admin-cli の `@crowi/api` が `^2.0.0-dev`、plugin-storage-aws-s3 devDeps の plugin-api が `0.1.0-dev` に展開)
- [x] **Phase 2 — peerDependencies 明文化** — 7 plugin (plugin-aws / plugin-storage-{local,aws-s3} / plugin-search-elasticsearch / plugin-renderer-{crowi-legacy,emoji,katex,plantuml}) の `dependencies.@crowi/plugin-api` を `peerDependencies` (`^0.1.0`) に移動、型解決用に `devDependencies.@crowi/plugin-api: workspace:*` を残置。plugin-storage-aws-s3 は `@crowi/plugin-aws` も peer 化。zod を直接 import する 5 plugin (plugin-aws / plugin-storage-local / plugin-storage-aws-s3 / plugin-search-elasticsearch / plugin-renderer-plantuml) は `zod: ^3.23.8` を peerDeps に昇格 (devDeps にも維持)。pack tarball で peerDeps が原文のまま preserve されていることを確認
- [x] **Phase 3 — pnpm catalog 導入** — `pnpm-workspace.yaml` に default `catalog:` を定義し、横断する dev tool / 外部 peer の 8 entry (`typescript ^5.8.3` / `tsup ^8.3.5` / `@types/node ^22.15.30` / `jest ^29.7.0` / `@types/jest ^29.5.14` / `ts-jest ^29.3.4` / `@ts-rest/core ^3.52.1` / `zod ^3.23.8`) を single source of truth に。15 package.json (apps 4 + packages 11) の該当 entries を `catalog:` 文字列に置換、ドリフトしていた typescript (`^5` / `^5.7.2` / `^5.8.3`) と @types/node (`^22.10.2` / `^22.15.30`) を統一。`@ts-rest/core` は api 経由 transitive な `@ts-rest/express ^3.52.1` に合わせて `^3.52.1` に揃え (元の `^3.51.0` から微増)。前提として `packageManager` を `pnpm@8.15.0` → `pnpm@9.15.9` にバンプ、`engines.pnpm: >=9.0.0`。lockfile は v6.0 → v9.0 に format 変換 (`catalogs.default` block が埋まり、参照は spec から resolve)。`apps/crowi-web` / `apps/crowi-site` の `@types/node: ^20` のみ catalog 化保留 — Next.js Vercel runtime と Node 22 typings の整合が未検証のため (後続 task で検討)。`pnpm pack` 検証を 3 plugin (renderer-emoji / storage-local / plugin-api) で実施、tarball 内で `catalog:` が実 version range (`^5.8.3` / `^3.52.1` / `^3.23.8` 等) に rewrite されることを確認。peerDependencies (zod / @ts-rest/core) でも catalog: が正しく展開される。**advisory 同梱**: `scripts/check-workspace-protocol.mjs` (zero-dep Node ESM、`@crowi/*` 参照について deps→`workspace:^` / devDeps→`workspace:*` / peerDeps→literal semver の規約違反を exit 1 で検知) を追加、`lefthook.yml pre-commit` jobs に `glob: '**/package.json'` で並列 hook 化、`pnpm check:workspace` script でも単発実行可。意図的に 1 package を破壊した dry-run で hook が exit 1 を返すことを実機確認。`sort-package-json` 導入は diff churn 回避のため別 task に持ち越し
- [ ] **Phase 3 follow-ups (advisory、simplify レビュー由来)** — (a) catalog 化候補の積み残し: `unified ^11.0.5` / `remark-parse ^11.0.0` / `@types/mdast ^4.0.4` (4 packages の remark stack)、`nodemon` / `ts-node` / `tsconfig-paths` / `dotenv` (api + dev-runner / admin-cli の 2 site cluster)。drift していないため緊急度低だが、まとめてバンプ時に効く。(b) `@ts-rest/react-query ^3.51.0` を `^3.52.1` に揃え (`@ts-rest/core` catalog 値と整合)。(c) `apps/crowi-web` / `apps/crowi-site` の `@types/node ^20` を Next.js Vercel runtime と Node 22 typings の整合検証後に catalog 化。(d) `sort-package-json` 導入 (key 並び統一)。Phase 4 か Phase 9 のついでに片付けるのが現実的
- [x] **Phase 4 — `@crowi/tsconfig` パッケージ化** — `packages/tsconfig/` に `base.json` (strict / esModuleInterop / forceConsistentCasingInFileNames / skipLibCheck / resolveJsonModule / isolatedModules) と `library.json` (target ES2020 / module ESNext / moduleResolution bundler / declaration+map+sourceMap) / `app-node.json` (target ES2022 / module commonjs / moduleResolution node16、phase-5 で消費予定) / `app-web.json` (target ES2022 / dom lib / module esnext / moduleResolution bundler / jsx react-jsx / noEmit / incremental / allowJs / plugins:[next]) を分離。11 library tsconfig (api-contract + admin-cli + plugin-{api,aws,renderer-{crowi-legacy,emoji,katex,plantuml},search-elasticsearch,storage-{aws-s3,local}}) を `extends "@crowi/tsconfig/library.json"` に置換、outDir/rootDir/types/include/exclude のみ consumer 側に残置。2 web tsconfig (crowi-web + crowi-site) を `extends "@crowi/tsconfig/app-web.json"` に置換、paths/include/exclude のみ残置。各 consumer の package.json devDeps に `@crowi/tsconfig: workspace:*` を alphabetical 順で追加 (13 consumer)。apps/crowi-web の target は ES2017 → ES2022 に bump (preset 統一、Next 16 は ES2022 が前提)。base.json 経由で `isolatedModules: true` が library 11 packages にも新規適用される (pre-diff は web 2 app のみ持っていた) — tsup ビルドは元々ファイル単位 isolated で動作しており、`const enum` / `export =` 等の禁止構文が library 側に存在しないため動作影響は無いが silent hardening として明記。apps/crowi-api は phase-5 で `app-node.json` 採用予定のため今回は据え置き。verification: type-check 26/26 / test 19/19 (api 593 tests) / lint 0 errors / format clean / check-workspace-protocol OK / `tsc --showConfig` で preset 値が consumer に正しく展開されることを plugin-renderer-emoji + apps/crowi-web で確認 / `pnpm pack` で 4 preset JSON + package.json が tarball に含まれることを確認
- [x] **Phase 5 — `apps/crowi-api` → `packages/api` 移動** — `git mv apps/crowi-api packages/api` で atomic に移動、`git log --follow` で履歴維持。path 参照を 38 ファイル追従 (root `tsconfig.json` `references[0].path`、`biome.json` ignore globs 5 件、`.github/workflows/ci.yml` working-directory、`apps/crowi-dev-runner/{nodemon.json,package.json}` scripts/watch path、`packages/api/nodemon.json` sibling plugin dist watch paths を `../../packages/X` → `../X` に 1 階層繰り上げ、`README.md` / `CLAUDE.md` のレイアウト ASCII art と env path 言及、`.claude/agents/*.md` 6 files + `.claude/skills/**/SKILL.md` 2 files、`packages/{api-contract,admin-cli,plugin-*}/src/*` のコメント参照 ~15 hits、apps/crowi-{web,site} CSS コメント 3 hits、`packages/api` 自己参照コメント 5 hits)。`packages/api/tsconfig.json` を `@crowi/tsconfig/app-node.json` extends に切替、preset が継承する target/lib/strict/skipLibCheck/esModuleInterop/forceConsistentCasingInFileNames/resolveJsonModule/isolatedModules を consumer から drop。`@crowi/tsconfig: workspace:*` を devDeps に alphabetical 順で追加。**preset 修正**: spec §e は app-node を `module: commonjs` + `moduleResolution: node16` と記述していたが TS 5.x で TS5110 (`moduleResolution: node16` は `module: node16|nodenext` を要求) で reject される無効な組み合わせ。`moduleResolution: node16` 採用 (node ESM mode) は ts-jest が `await import(...)` を真の ESM dynamic import として保持し `--experimental-vm-modules` 無しで test suite 全落ちさせるため不可。simplify レビューで「preset を `module: commonjs` + `moduleResolution: node` に揃え、consumer override から module/moduleResolution を drop」を採用 — preset が現実の唯一の consumer (packages/api) と一致し、preset の意義 (target/lib/module/moduleResolution を集約) が回復。将来 ts-jest が node16 ESM をサポートしたら `app-node-esm.json` を別 preset として追加検討。`tsc --showConfig` で target=es2022 / module=commonjs / moduleResolution=node10 / strict / isolatedModules / esModuleInterop / skipLibCheck / forceConsistentCasingInFileNames / resolveJsonModule の継承を確認。RFC アーカイブとして `TODO.md` 既存履歴と `docs/rfcs/0001-plugin-architecture.md` L546 の `apps/crowi-api` 参照は historical accuracy 保持で touched せず。verification: type-check 26/26 / test 19/19 (api 593 tests) / lint 0 errors / format clean / check-workspace-protocol 16 OK
- [ ] **Phase 6-9** — `apps/crowi-web` → `packages/web` 移動 / `@crowi/runner` 切り出し + dev-runner 廃止 / Dockerfile 整備 / changesets + CI publish workflow。spec は `.feature-state/specs/feature-monorepo-packages-restructure.md` 参照。plugin-api の major 昇格 (`0.1.0-dev` → `1.0.0`) は Phase 9 (changesets) と一緒に検討
- [ ] **Phase 9 advisory — devDeps mirror が tarball に prerelease pin として残る問題** (simplify レビュー由来) — `pnpm pack` は `devDependencies` を strip しないため、現状の mirror `@crowi/plugin-api: workspace:*` は published tarball で `0.1.0-dev` の pinned (caret なし) prerelease tag に展開される。consumer が `pnpm install --prod=false` 等で dev dep を解決すると registry に存在しない `0.1.0-dev` で ETARGET。Phase 9 で plugin-api を non-prerelease (`1.0.0`) に昇格すると同時に、(a) mirror を `workspace:^` に切替 (`^x.y.z` で range 化) or (b) `prepack` で mirror devDeps を削除、のどちらかを採用

### Installer 移行 (フェーズ 0)
- [x] **未インストール時の自動 redirect** (`/migrate migrate-installer-process` → `ed1c598d`) — `useInstallerStatus()` + `<InstallerGate>` を root layout に mount、`/installer` ⇄ それ以外を双方向制御
- [x] **`installer.createAdmin` を ts-rest 内に native 化** (`4ec708e8`) — legacy controller への delegation を廃止 (`req.form.isValid` undefined クラッシュ解消)。Zod schema に legacy regex (username `[\da-zA-Z\-_.]+`、password `[\x20-\x7F]{6,}`) 移植
- [x] **installer status を DB 直クエリに** (`82b6be40`) — boot-time cache が `applicationInstall()` 後に stale になる問題を `Config.countDocuments({ns:'crowi'})` 直参照で解決。install 成功後は `crowi.getConfigService().load()` で cache refresh

### Plugin Architecture (RFC-0001)
- [x] **adminPlacement + plugin-driven sidebar** (`a092cd8f`) + **不要 card header 整理** (`0b2619fa`)
- [x] **plugin admin UI Step 7** — `/admin/plugins` 一覧 → 単一 plugin 編集ページ、auto-form (kind ベース control)、`@sensitive` / `@action` 対応、設定の暗号化保存 (`061ae3ed`)
- [x] **plugin name に `/` を含む npm scope の query string 対応** (`24ec1ef4`) — Express path-param が `@crowi/storage-local` で broken
- [x] **`@crowi/aws` / `@crowi/storage-aws-s3` / `@crowi/storage-local` の段階的 split** + 共通 base plugin "共通サービス" 名称決定
- [x] **plugin-s3 worktree 統合** (merge `433166a6` + simplify `c8156b11`) — `@crowi/plugin-{aws,storage-aws-s3,storage-local}` 化、`/admin/storage`、`@crowi/admin-cli` (`crowi-admin storage copy`)、AWS config boot-time migration、`apps/crowi-dev-runner` 導入、`/crowi-feature` skill + 4 agent 新設、`FILE_UPLOAD` env / `app:fileUpload` toggle 廃止
- [x] **deps-hint banner** (`/crowi-feature feature-admin-plugin-deps-hint` → `5798bea5` + `3004d857`) — `/admin/plugins/edit?name=<X>` で X が `requires` を持つときに依存先 plugin の必須フィールド未設定 / 未インストールを警告。`useAdminPluginConfigs` (parallel `useQueries`、cache key 共有)。i18n 4 keys

### Header / Theming / URL 整理
- [x] **clear header + popover shadow テーマ化** (`986873dd` + simplify `879e3e7a`) — 旧 Crowi の white header + gradient top border + lifted shadow を移植。`--shadow-popover` / `--shadow-header` を `@theme inline` に集約、shadcn dropdown / dialog / alert-dialog 全部に適用。`UserDropdownIdentity` + `SiteBrand` 抽出、`UserMenuItems` を legacy 順 (Settings → Bookmarks → Created → Trash → Logout) に
- [x] **設定済み site title を header に表示** (`4829ef59`) — `GET /api/v2/app/info` (public)、`useAppInfo` hook、title 設定済 → icon-only + title / 未設定 → full lockup
- [x] **login / installer / register に旧 nologin gradient + animation 移植** (`97c10d04`) — `.bg-crowi-login` 3層 linear-gradient + 20s pan animation + `prefers-reduced-motion` 対応
- [x] **`/_history` 予約ルート** (`bef81f83` + `41d47607`) — catch-all `[[...slug]]` の `/foo/history` 検出を撤去、`/_history?path=...` (Next.js 仕様で `%5Fhistory` フォルダ名) に移行
- [x] **`/settings` → `/me` / `/notifications` → `/_notifications`** (`0c381291`) — レガシー Crowi の URL 名前空間に合わせる (ユーザー作成ページ slug との衝突回避)。設定の通知タブも撤去 (placeholder のみだったため)
- [x] **locale 同期 + popover 言語メニュー撤去** (`b4cf720a` + `8a47e65d`) — `<LocaleSync>` を root に mount、`User.lang` ↔ paraglide cookie を双方向同期。popover の言語選択を撤去、`/me` の Language `<Select>` 一本化。`/me` 配下を 80 keys で全面 i18n 化

### 管理画面 (フェーズ 4) を一気に整備
- [x] **/admin/{app,security,auth,mail,share,users}** を ts-rest + Next.js で実装。並行 worktree → `/integrate-worktree` で順次統合 → 各 simplify pass で post-merge cleanup
  - integrate commits: `39cf0e5c` (auth) / `f9e0c54c` (mail) / `805f8990` (users) / `e163345a` (share)
- [x] **横断的 advisory 11 件をまとめて解消** (`37b35eda`〜`0bce9def` + `6ca1e0e1`):
  - `util/admin-config.ts`: `coerceBoolean` / `coerceString` / `coerceNumber` / `coerceStringArray` + `getCrowiConfigNamespace`
  - `util/ts-rest-helpers.ts`: `internalServerErrorResponse`
  - `util/admin-pager.ts` + `schemas/admin/_pager.ts`: `createPager` / `AdminPagerSchema` の lift
  - `schemas/admin/_aws.ts`: AWS region / accessKeyId schema 集約
  - `messages/{ja,en}.json`: `admin.common.*` (12 キー)
  - `lib/admin-settings-factory.ts`: `createAdminSettingsHooks` (share/auth/security)
  - `components/admin/secret-field.tsx`: 3 サイトの secret block 集約
  - `userPublic.ts`: `UserPublic.status` を `z.nativeEnum` で型付け
  - `models/user.ts`: `paginate` を typed に + `select` で機密フィールド projection
  - admin form の pristine PUT skip (auth / security に展開、mail / share / app は元々対応済)

### バグ fix (このセッション)
- [x] **Redis pub/sub v4 API 移行** (`c18a5857`) — `subscriber.subscribe(channel, listener)` の listener が v3 形式で渡されておらず、config save 時に `TypeError: listener is not a function` でクラッシュしていた問題を修正
- [x] **`UserStatusEnum` re-export を value alias に** (`347b439a`) — tsup v8 で `export { X as Y } from` 形式が壊れたバンドルを出力する問題を回避(dist の shorthand property エラー)
- [x] **Button cursor flicker 修正** (`a29d9975` + `c32aa5dd` + `7ba77a2d` + `4901ad0c`):
  - `cursor-pointer` を Button base に明示(Tailwind v4 で `@layer base` ルールが Turbopack 下で勝てない)
  - `disabled:pointer-events-none` → `disabled:cursor-not-allowed`(pointer-events:none で cursor が親要素にフォールバックする flicker)
  - `transition-all` → `transition-colors`(全プロパティ遷移の repaint cycle 抑止)

### Sensitive data の at-rest 暗号化 (Phase 1 + 2、main 直)
- [x] **crypto util** (`5cb82a8d`) — AES-256-GCM + KeyProvider 抽象 + `enc:v1:<iv>:<tag>:<ct>` envelope。9 件のテスト
- [x] **Config の sensitive 経路** (`3bc886e9`) — 9 つの sensitive key (OAuth secret / AWS keys / SMTP / Slack token) を `updateByParams` で encrypt、`loadAllConfig` で decrypt。レガシー plaintext 行は素通し
- [x] **起動時 KEY 検証 + .env.sample** (`553f533d`) — `setupEncryption` で 32 バイト検証、未設定なら警告のみで起動継続。`pnpm --filter @crowi/api crypto:gen-key` 追加
- [x] **admin crypto status / reencrypt API** (`45446298`) — GET `/admin/crypto/status` (件数 + per-entry encrypted フラグ) + POST `/admin/crypto/reencrypt` (一括再暗号化)。jwtAdminRequired で gate、7 件のテスト
- [x] **admin dashboard 警告 UI** (`ee4c75a9`) — `CryptoStatusCard` で 4 状態 (未設定 / 未暗号化あり / 全暗号化済 / まだデータなし) を表示し、再暗号化ボタンを提供
- [ ] **Phase 3 (将来)**: KeyProvider を pluggable 化、AWS KMS / GCP KMS provider を `optionalDependencies` で追加 (要件: IAM Role 運用 / audit log)
- [ ] **lookup-key 系 secret の対応**: `User.apiToken` / `Share.secretKeyword` は equality lookup されるため hash 化または deterministic encryption が必要。別 issue

### 並行 worktree 統合 (`/integrate-worktree`)
- [x] **trash 統合** (`c5a9e8ec` + simplify `0cd08638`) — `/trash/*` 一覧 + Restore / Delete forever。`useDeletePage` / `useRevertDeletedPage` の `['pages']` invalidate 追加で行が即時に消えるよう修正
- [x] **pages-watch 統合** (`d7538524` + simplify `e2687f87`) — Bell / BellOff の WatchButton + GET/PUT `/pages/watch` (Watcher upsert + `getNotificationTargetUsers` フォールバック)。`useToggleWatch` を `useToggleBookmark` 流の状態導出に整理、`useWatchStatus` に 5min staleTime
- [x] **notification-subscribe を破棄** — pages-watch と完全重複していたため `gw end -f`
- [x] **notification 統合** (`60311ad3`) — Bell + 30s polling + `/notifications` 画面
- [x] **pages-revisions 統合** (`c8bd4c4e`) — `/page/history` + diff viewer (react-diff-viewer-continued)
- [x] **pages-likes 統合** (`70cf0656` + simplify `e6fe27be`) — Like button + `loadGrantedPage` への refactor
- [x] **pages-seen 統合** (`da16f3b6`) — Seen by avatars + auto-mark on view
- [x] **pages-rename-ui 統合** (`a6ff7104`) — Rename Dialog
- [x] **pages-remove 統合** (`c63c87e6` + simplify `0c7621f1`) — Delete / Restore + pageNotFoundResponse hoist
- [x] **page-comment 統合** (`bbe2a2dd` + simplify `89b45630`) — 共有 helper 抽出 (toPageUser / toISOStringOrNull / isValidObjectId)
- [x] **page-bookmark 統合** (`a76e4f9c` + simplify `9d74e0de`) — Bookmark button
- [x] **page-rename 統合** (`5d0942e3` + simplify `0c7621f1`) — Rename API

### Web UI 改善 (main 直)
- [x] **Seen by を avatar stack + N+ more dialog 化** (`a2b37dde` + `20da8dbd`) — preview 10 件は重なりアバター、超過分は `+N more` ボタンで Dialog から全件閲覧。`PageSchema` から id 配列の `seenUsers` を撤去 (count のみ)、`getSeenUsers` に `limit` query 追加でペイロードを軽量化
- [x] **PageActionsMenu (...menu)** (`b224f009`) — Rename / Delete を menu に集約してヘッダーをスッキリ
- [x] **portal page で PageHeader を表示** (`230110a6`) — Bookmark / Edit / ... menu / SeenBy が portal にも
- [x] **`/user/<username>` で page document を表示** (`dce8f7df`) — profile + page content + tabs

### 直接実装した API + UI
- [x] **ID リダイレクター** (`/<24hex>` `/_r/<24hex>`、Web 側のみ)
- [x] **ページ編集 UI 最小実装** (`/edit?page_id=...` / `?path=...`)
- [x] **pages.update API** (`PUT /api/v2/pages`)
- [x] **pages.create API** (`POST /api/v2/pages`)

### 開発運用 / 品質
- [x] **`pnpm lint` を全 workflow で必須化** (`fb6f8b50` + `92c625a3`)
  - React 19 set-state-in-effect エラー 2 件を解消
  - migration-implementer / reviewer / integrate-worktree の必須チェックに pnpm lint 追加
  - lefthook pre-push lint を有効化 (errors=0 必須、warnings は advisory)
- [x] **Biome + lefthook 導入** (`766830cf` + `495bef27`)
  - Prettier → Biome に置換、`.ts/.tsx/.js/.jsx` を root から一括 format
  - lefthook pre-commit で staged ファイル自動 format → 「format 漏れ」根本解決
  - 全コードベースを Biome で再 format
- [x] **`integrate-worktree` skill 新設** (worktree → main → simplify ワークフロー、tmux window auto-close 含む)
- [x] **migration skill / agent 全面書き直し** (実態に合わせ、main-direct + simplify フェーズ追加)
- [x] **docker-compose を依存サービスのみに整理** (app コンテナは host で `pnpm dev`)
- [x] **`turbo.json` の `^build` 依存追加** (dev で型解決のレース解消)
- [x] **api-contract watch を `--no-clean` 化** (TS2305 race fix)
- [x] **bcrypt パスワードハッシュ移行** (旧 SHA-256 から)
- [x] **接続エラーハンドリング** (Banner + Modal)

## Recently Completed (過去セッション、PR ベース)

- [x] User Settings (profile + picture / password / API token) — PR #892, #893, #897
- [x] Page 表示 (single + list + portal, Markdown レンダリング) — PR #894, #895, #896
- [x] User Page (profile / bookmarks / recent-create) — PR #898
- [x] Logout / Header dropdown — PR #899
- [x] `applicationInstalled` middleware を JSON error 化 (HTTP 503)
- [x] `loginRequired` middleware を JSON error 化 (HTTP 401/403)
- [x] 共通 error schemas (`ApiError`, `AuthenticationRequiredError`, etc.)

## Notes

- **運用方針**: main 直コミット (`commitStrategy: main-direct`)、push と PR は明示指示待ち
- **並行作業**: `gw start <name>` で worktree を作成、終わったら `/integrate-worktree <name>` で合流
- **ts-rest routes**: `/api/v2` prefix
- **api-contract build**: `pnpm --filter @crowi/api-contract build` (dev では `^build` 依存で自動)
- **state ディレクトリ**: `.migration-state/` (root、gitignore 済) — `.claude/migration-state/` ではない
- **format / lint**: pre-commit で biome format、pre-push で `pnpm lint` (errors=0)
- 旧 controller / 旧 Swig は段階的に削除予定 (新側が安定してから)

## Operator runbooks

### Storage driver の切替 / ファイル移行

1. (任意) 切替前に dry-run でコピー対象件数を確認:
   - dev: `pnpm --filter @crowi/dev-runner exec crowi-admin storage copy --from local --to s3 --dry-run`
   - prod: runner directory で `crowi-admin storage copy --from local --to s3 --dry-run`
2. メンテナンス時間中(server 停止中が安全)に dry-run を外して実行: `crowi-admin storage copy --from local --to s3`。失敗があっても全体は完走し、最後に `{ ok / failed / skipped / total }` summary が出る。再実行は安全(`put` は overwrite-by-key)。
3. `crowi.config.json:storage.driver` を新 driver 名に変更してプロセスを再起動。
4. `/admin/storage` を開いて新 driver が active と表示されることを確認。
5. 旧 driver のデータは温存される(将来 cleanup task で削除を検討)。

### AWS 認証情報の boot-time migration

旧 `upload:aws:*` 設定が Mongo に残っているサイトは、初回起動時に自動で `plugin:@crowi/plugin-aws:*` (region / accessKeyId / secretAccessKey) と `plugin:@crowi/plugin-storage-aws-s3:bucket` にコピーされる。新キーに既に値が入っている場合は触らない(operator が新キーを直接編集したケースを保護)。boot ログに `Migrated N legacy upload:aws:* config key(s)` と出る。rollback 用に旧キーは残るので、安心が確認できたら別タスクで削除する。
