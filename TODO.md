# TODO List

Crowi 2.0 移行 (Express + Swig → Next.js + ts-rest)。フェーズ別。
ロードマップの詳細は project memory (`migration_roadmap.md`) を参照。

## High Priority — フェーズ 1 残 (ページ機能の完成)

🎉 **フェーズ 1 完了** — Trash / page watch / Seen by 改善まで反映済み。
詳細は「Recently Completed (このセッション)」を参照。

## High Priority — 横断的 advisory (累積)

- [x] **UI 共通化** (`2c390a55`): `LoadingSpinner` / `ErrorAlert` / `AccessDeniedCard` / `NotFoundCard` を `apps/crowi-web/src/components/ui/` に抽出。9 ファイル / 13 サイトで重複削減
- [ ] **JP/EN 文言の統一 / i18n 戦略確立**: 現状 `page-view` は EN、`use-page-mutations` / notification 系は JP。i18next 等の導入判断を含む
- [x] **`req.user` の Express type augmentation** (`8e8524ac`): `apps/crowi-api/src/types/express.ts` で global 拡張、35 サイトの cast を撲滅
- [x] **`pageToResponse` / `toPageUser` / `toUserPublic` / `isPopulatedUser` の統一** (`6c43ef77` + `8b2fe70f`):
  - `toUserPublic` を util に統合 (`PopulatedUserPublic` 経由で fallback 対応)
  - `isPopulatedUser` を util に集約 (loose triplet 判定)
  - `pageNotFoundResponse` / `invalidPageIdResponse` を util の const に
  - `pageToResponse` の date 系を fallback (createdAt/updatedAt が undefined でも schema を満たす) に
- [x] **`loadGrantedPage` を util に格上げ** (`0f988d3e`): `PageModelLike` 経由で page / bookmark / comment / notification / revision から呼べるように昇格

## Medium Priority — フェーズ 2 残 / 周辺機能

- [ ] **Backlinks**: `_api/backlink.list` (Web UI: 編集画面下部にリンク一覧)
- [ ] **残りの認証 routes**:
  - `GET /login/google` / `GET /login/github` / 各 callback
  - `GET /login/invited` / `POST /login/activateInvited`
- [ ] **残り middleware の JSON 化**:
  - `adminRequired` / `applicationNotInstalled` / `fileAccessRightOrLoginRequired`
- [ ] **error code 細分化**: comment.ts / revision.ts などの `INVALID_REQUEST` を `MISSING_REQUIRED_FIELD` / `INVALID_OBJECT_ID` / `*_FAILED` に分割
- [x] **`usePageComments` を 3 hooks に split** (`8d6b695c`): 11 fields 返す巨大 hook を `usePageCommentsList` / `useAddComment` / `useDeleteComment` に分割
- [ ] **`Backlink.createBySavedPage` を bulk insert 化**: 現状 `deleteMany` → N×`isExist*` → N×`Backlink.create()` で 1 ページ保存ごとに ~1+2K round-trips。`insertMany` + (理想的には) 旧/新リンクの set-difference に置き換え。`backlink.ts:98-122` 周辺
- [ ] **`unwrapResult(result, ...)` ts-rest helper を抽出**: `apps/crowi-web/src/lib/use-{bookmark,watch,like,page-mutations,page-comments,backlinks,...}.ts` の `if (result.status === 200) return result.body; if (status === 401) throw ... ` ladder が 13+ サイトに重複。helper 化で一気に整理可能
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
- [ ] **Attachments**: `attachments.list` / `attachments.add` / `attachments.remove`

## Low Priority — フェーズ 4 (管理画面、重い)

旧実装の管理画面 React は Phase 1 で削除済み。API endpoints だけ
`apps/crowi-api/src/routes/api/admin.ts` に残っているので、ts-rest 化 + Next.js 管理
画面 (`apps/crowi-web/src/app/(admin)/`) を新設する。

### 基盤
- [x] **adminRequired middleware を JSON 化** (Medium Priority に既出、依存) — 8abd0c8f
- [x] **`/admin` index** + Admin layout (sidebar / breadcrumb) — 5123e06d
- [x] Next.js Route Group `(admin)` 設計、admin 専用認可 (User.admin === true) — 5123e06d

### 設定 (Config model に集約、各セクションで部分更新)
- [x] **App** (`GET/PUT /admin/app`): サイト名 / 機密情報の注意書き / fileUpload toggle / AWS S3 認証情報。secretAccessKey は暗号化保存 + UI で 3 状態(saved / clear pending / dirty)
- [x] **Security** (`GET/PUT /admin/security`): basic 認証 / registrationMode / registrationWhiteList
- [x] **Authentication** (`GET/PUT /admin/auth`): requireThirdPartyAuth / disablePasswordAuth + 自分自身のロックアウト防止 (422)
- [x] **Mail / SMTP** (`GET/PUT /admin/mail` + `POST /admin/mail/test`): from / SMTP host / port / user / password + AWS SES + テスト送信
- [x] **Share** (`GET/PUT /admin/share`): 外部共有 link の有効/無効 toggle + 旧 form/route 削除
- [ ] **Google OAuth** (`POST /admin/settings/google`): clientId / secret
- [ ] **GitHub OAuth** (`POST /admin/settings/github`): clientId / secret / org
- ~~AWS / S3 file storage~~: `admin/app` の upload section に統合済

### ユーザー管理
- [x] **User 一覧** (`GET /admin/users`) + 検索 (`GET /admin/users.search`) — `0223d46b` + `8316d50a` + `7820711c`: ts-rest contract / API ハンドラ (createPager 移植 + UserPublic 絞込み) / Web 画面 (URL state 同期 + debounce 検索 + numbered pager)。アクション系は別タスク
- [ ] **招待** (`POST /admin/user/invite`): メールアドレスで招待送信
- [ ] **編集** (`POST /admin/user/:id/edit`): name / email / status の手動修正
- [ ] **権限** (`POST /admin/user/:id/makeAdmin` / `removeFromAdmin`)
- [ ] **アカウント状態** (`POST /admin/user/:id/activate` / `suspend`)
- [ ] **パスワードリセット** (`POST /admin/users.resetPassword`): 仮 PW 発行 + メール送信
- [ ] **メール変更** (`POST /admin/users.updateEmail`): 強制変更 (admin のみ)

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
- API endpoints: `apps/crowi-api/src/routes/api/admin.ts`
- Express ルート (legacy GET, SPA index 返し): `apps/crowi-api/src/routes/admin.ts`
- Controller: `apps/crowi-api/src/controllers/admin.ts`
- Form validators: `apps/crowi-api/src/form/admin/*`
- 旧 Swig views は **既に削除済み** (Phase 1 で React/views クリア時に)

## Low Priority — フェーズ 5 (共有 / OAuth / 招待)

- [ ] Shares CRUD + secretKeyword
- [ ] Slack event endpoint (受信側、`/_api/slack/event`)
- [ ] 招待ログイン (`invited` / `activateInvited`)

## Low Priority — クリーンアップ

- [ ] 旧 Express routes / controllers の除去 (ts-rest 移行完了後)
- [ ] 旧 Swig views の削除
- [ ] `apps/crowi-api/src/util/apiResponse.ts` (legacy) の整理
- [ ] テスト整備 (web 側のテスト基盤、API の coverage 強化)
- [ ] エディタ強化 (Markdown プレビュー / リッチエディタ / 自動保存 / 画像アップロード)

## Recently Completed (このセッション)

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
