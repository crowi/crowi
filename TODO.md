# TODO List

Crowi 2.0 移行 (Express + Swig → Next.js + ts-rest)。フェーズ別。
ロードマップの詳細は project memory (`migration_roadmap.md`) を参照。

## High Priority — フェーズ 1 残 (ページ機能の完成)

- [ ] **ページ削除・復元 API + UI**
  - `pages.remove` / `pages.revertRemove` / `pages.unlink`
  - Trash 表示画面 (`/trash/*`)
- [ ] **既読 / watch**
  - `pages.seen` / `pages.watch` / `pages.watch.status`
- [ ] **リネーム UI** (API は実装済 → `POST /api/v2/pages/rename`)
  - フォーム + 衝突確認ダイアログ
  - `pages.checkTreeRenamable` / `pages.renameTree` も検討

## High Priority — 横断的 advisory (累積)

- [ ] **UI 共通化**: `LoadingSpinner` / `ErrorAlert` / `AccessDeniedCard` / `NotFoundCard` を `apps/crowi-web/src/components/ui/` に抽出 (5+ 箇所重複)
- [ ] **JP/EN 文言の統一 / i18n 戦略確立**: 現状 `page-view` は EN、`use-page-mutations` 等は JP。i18next 等の導入判断を含む
- [ ] **`req.user` の Express type augmentation**: `apps/crowi-api/src/types/express.d.ts` で global 拡張、3 種類の cast を撲滅
- [ ] **`pageToResponse` 統一**: page.ts (`any` 経由) と user.ts/bookmark.ts (型 strict) を揃える。`PageSchema` の date フィールドを nullable に揃える必要あり

## Medium Priority — フェーズ 2 残 / 周辺機能

- [ ] **Likes**: `likes.add` / `likes.remove`
- [ ] **Revisions**: `revisions.get` / `revisions.ids` / `revisions.list`
- [ ] **Backlinks**: `_api/backlink.list`
- [ ] **残りの認証 routes**:
  - `GET /login/google` / `GET /login/github` / 各 callback
  - `GET /login/invited` / `POST /login/activateInvited`
- [ ] **残り middleware の JSON 化**:
  - `adminRequired` / `applicationNotInstalled` / `fileAccessRightOrLoginRequired`
- [ ] **error code 細分化**: comment.ts などの `INVALID_REQUEST` を `MISSING_REQUIRED_FIELD` / `INVALID_OBJECT_ID` / etc. に分割
- [ ] **`usePageComments` を 3 hooks に split**

## Medium Priority — フェーズ 3 (検索 / アセット)

- [ ] **検索画面**: `/_search` / `/_api/search`
- [ ] **Elasticsearch 復活** (現在 docker-compose から外し中、バージョン更新込み)
- [ ] **Attachments**: `attachments.list` / `attachments.add` / `attachments.remove`

## Low Priority — フェーズ 4 (管理画面、重い)

旧実装の管理画面 React は Phase 1 で削除済み。API endpoints だけ
`apps/crowi-api/src/routes/api/admin.ts` に残っているので、ts-rest 化 + Next.js 管理
画面 (`apps/crowi-web/src/app/(admin)/`) を新設する。

### 基盤
- [ ] **adminRequired middleware を JSON 化** (Medium Priority に既出、依存)
- [ ] **`/admin` index** + Admin layout (sidebar / breadcrumb)
- [ ] Next.js Route Group `(admin)` 設計、admin 専用認可 (User.admin === true)

### 設定 (Config model に集約、各セクションで部分更新)
- [ ] **App** (`POST /admin/settings/app`): サイト名、デフォルト言語、`fileUpload` type 等
- [ ] **Security** (`POST /admin/settings/sec`): ゲスト閲覧許可、招待のみモード等
- [ ] **Authentication** (`POST /admin/settings/auth`): ローカル認証 / 招待制 ON-OFF
- [ ] **Mail / SMTP** (`POST /admin/settings/mail`): from / SMTP host / port / auth
- [ ] **AWS / S3 file storage** (`POST /admin/settings/aws`): bucket / region / accessKey / secret
- [ ] **Google OAuth** (`POST /admin/settings/google`): clientId / secret
- [ ] **GitHub OAuth** (`POST /admin/settings/github`): clientId / secret / org
- [ ] **Share** (`POST /admin/settings/share`): 公開共有の有効/無効

### ユーザー管理
- [ ] **User 一覧** (`GET /admin/users`) + 検索 (`GET /admin/users.search`)
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

## Low Priority — フェーズ 5 (共有 / 通知 / OAuth)

- [ ] Shares CRUD + secretKeyword
- [ ] Notification (list / read / open / status)
- [ ] Slack event endpoint
- [ ] 招待ログイン

## Low Priority — クリーンアップ

- [ ] 旧 Express routes / controllers の除去 (ts-rest 移行完了後)
- [ ] 旧 Swig views の削除
- [ ] `apps/crowi-api/src/util/apiResponse.ts` (legacy) の整理
- [ ] テスト整備 (web 側のテスト基盤、API の coverage 強化)
- [ ] エディタ強化 (Markdown プレビュー / リッチエディタ / 自動保存 / 画像アップロード)

## Recently Completed (このセッション)

- [x] **`pnpm lint` を全 workflow で必須化** (`fb6f8b50` + `92c625a3`)
  - React 19 set-state-in-effect エラー 2 件を解消 (comment-form / edit-page-client)
  - migration-implementer / reviewer / integrate-worktree の必須チェックに pnpm lint 追加
  - lefthook pre-push lint を有効化 (errors=0 必須、warnings は advisory)
- [x] **Biome + lefthook 導入** (`766830cf` + `495bef27`)
  - Prettier → Biome に置換、`.ts/.tsx/.js/.jsx` を root から一括 format
  - lefthook pre-commit で staged ファイル自動 format → 「format 漏れ」根本解決
  - 全コードベースを Biome で再 format
- [x] **page-rename 統合** (`5d0942e3` + simplify `0c7621f1`)
- [x] **page-bookmark 統合** (`a76e4f9c` + simplify `9d74e0de`)
- [x] **page-comment 統合** (`bbe2a2dd` + simplify `89b45630`)
- [x] **`integrate-worktree` skill 新設** (worktree → main → simplify ワークフロー)
- [x] **ID リダイレクター** (`/<24hex>` `/_r/<24hex>`、Web 側のみ)
- [x] **ページ編集 UI 最小実装** (`/edit?page_id=...` / `?path=...`)
- [x] **pages.update API** (`PUT /api/v2/pages`)
- [x] **pages.create API** (`POST /api/v2/pages`)
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
- 旧 controller / 旧 Swig は段階的に削除予定 (新側が安定してから)
