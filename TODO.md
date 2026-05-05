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

- [ ] **Web 側 React 19 lint errors を解消** (2 件、pre-push lint hook 有効化の前提)
  - `apps/crowi-web/src/app/(auth)/edit/edit-page-client.tsx:117` (setState in useEffect)
  - `apps/crowi-web/src/components/page-comments/comment-form.tsx:20` (同上)
  - 解消後 `lefthook.yml` の pre-push lint コメントアウトを外す
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

- [ ] `/admin/*` 全般 (settings 各カテゴリ、user 管理、notification、search index 再構築)
- [ ] Slack 連携設定
- [ ] ユーザー招待 / suspend / makeAdmin
- [ ] views/admin の Swig が完全に未移行

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
