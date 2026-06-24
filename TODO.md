# TODO List

Crowi 2.0 (Express + Swig → Next.js + Hono)。**2.0.0-alpha1 リリース準備中**。

> このファイルは**全体感の把握用**。実装詳細・経緯は書かない（肥大化防止）。
> 詳細は git log / RFC (`docs/rfcs/`) / spec (`.feature-state/specs/`) を参照。
> 各項目は原則 1 行。spec/RFC があればポインタだけ残す。

---

## 🎯 Now — 2.0.0-alpha1 リリース準備

spec: `feature-v2-alpha1-release-prep.md`（実本番 = v1 DB への in-place アップグレード前提）

- [ ] **外部共有機能の削除**（Share モデルは dormant 据え置き、LinkSharePopover は残す）
- [ ] **ソーシャルログイン削除**（Google/GitHub。認証ポリシー設定は不活性化で残す、User schema は dormant）
- [ ] **通知設定メニュー削除**（admin サイドバーの stub のみ）
- [x] **renameTree 移行** — `POST /pages/rename` に `include_descendants`
- [ ] **prod build / runner 検証** — prod build で plugin 解決できるか
  - [x] runner-project 方式 Phase 1（spec: `feature-prod-runner-project.md`）
  - [ ] slim image + 外部 operator 向け doc — blocked-on `feature-plugin-search-mongo`
- [x] **v1→v2 データ移行（RFC-0008）** — migration framework
- [x] **HTML タグ移行の不具合修正** — wikilink close-tag 誤爆 + TOC HTML 混入の修正と復旧 migration（spec: `feature-migration-html-tag-fixes.md`）
- [x] **wikilink-format コード領域除外 + apply タイムスタンプ保全** — フェンス/インラインコード内 `</…>` を誤検知しない（`code-mask.ts` の `splitCodeSegments`）+ body-rewrite migration の `apply` がページの `updatedAt`/`lastUpdateUser` を bump せず保全（spec: `feature-migration-wikilink-code-exclusion.md`）
- [x] **migration preflight severity（RFC-0008 BUG 2）** — `MigrationDefinition` に必須 `severity:'cosmetic'|'blocking'` を追加し boot probe を severity 別に分割。cosmetic preflight が pending でも warn-and-continue（`block` でも起動継続）、`user-unique-prepare` のみ blocking で従来通り起動拒否。新規ページ再 pending 化による永続起動拒否デッドロックを解消。`migrate list`/`plan` に `[blocking]`/`[cosmetic]` タグ（spec: `feature-migration-preflight-severity.md`）
- [ ] **version bump + tag** — linked group を `2.0.0-alpha.0` へ。npm publish はしない

---

## High Priority — 進行中

### Plugin Architecture (RFC-0001)
- [ ] Step 8: notifier (Slack) plugin 化
- [ ] Step 10: auth provider plugin 化（OAuth。alpha1 で削除、将来 plugin で復活）
- [ ] 将来: encryption KeyProvider plugin (KMS)、S3 以外の attachment storage

### OAuth 2.0 (RFC-0010)
- [ ] Phase 5: admin による任意 OAuth クライアント登録 UI（Phase 1-4 完了）

### 配布 / リリース（2.0.0 stable 時）
- [ ] **無印 `crowi` パッケージの整理**（spec: `feature-crowi-quickstart-package.md`）
- [x] **web image の API URL 実行時注入**（同一オリジン既定。spec: `feature-web-image-runtime-config.md`）
- [x] **web image クロスオリジン runtime-env 注入**（§e フォローオン。spec: `feature-web-cross-origin-runtime-env.md`）
- [x] **CI リリース自動化** — changesets + npm OIDC + Docker(full/slim) + ES image。手順は operations/release-runbook（spec: `feature-ci-release-automation.md`）

### 管理画面 残（フェーズ4）
- [ ] Slack channel 通知（page-path→channel mapping + Slack 統合設定）

### その他 残作業
- [ ] error code 細分化（comment/revision の `INVALID_REQUEST`）
- [ ] Slack event endpoint（`/_api/slack/event`）
- [ ] web テスト基盤整備 + API coverage 強化

---

## バックログ — deferred refactor / advisory

merge 後の simplify レビューで挙がった非ブロッキング改善。詳細は各 advisory コミット参照。

- [ ] **WS 基盤の重複抽出**（notifications/presence/collab の 3-way 重複）
- [ ] **RFC-0003 collab advisory**（util 重複、collab models 型付け、Yjs batch 化 ほか）
- [ ] **RFC-0004 editor advisory**（autocomplete COLLSCAN、attachment helper 共有 ほか）
- [ ] **RFC-0005 presence advisory**（heartbeat pipeline 化、token util 抽出）
- [ ] **feature 別 advisory**（inline-attachment regex、mail-token helper、error-codes i18n ほか）
- [ ] **RFC-0002 renderer 残**（Mermaid、GitHub Embed plugin、mention N+1 ほか）
- [ ] **monorepo restructure follow-ups**（catalog 化、compose healthcheck、dev/prod parity ほか）
- [ ] **crypto Phase 3**（KeyProvider pluggable 化、lookup-key secret の hash 化）
- [ ] **RFC-0008 follow-ups**（`rebuild renderer`/`backlink` 本実装、watcher backfill 統一、RFC 追従）
- [ ] **STATIC_CAPABILITIES drift guard**（boot 時に static capability ↔ route group の assert test）
- [ ] **MCP result body advisory**（body を返す read tool 増加時に `okResult` で text/structured 一経路化）
- [ ] **renameTree merge advisory**（subtree-rename 2 ルートの重複集約、`checkPagesRenamable` の N+1 ほか）
- [ ] **migration-html-tag-fixes merge advisory** — `forEachPublishedCurrentRevision` の採用拡大（`wikilink-format` / `files-url-to-attachments` を寄せて walk 3 実装→1・per-page `findById` N+1 解消）+ web `known-tags.ts` の `HTML_TAGS` を `@crowi/api-contract` の `KNOWN_HTML_ELEMENTS` から生成（SVG/custom 要素差分は別管理）
- [ ] **eslint 8 → 9 major up**（`packages/api` / `packages/collab` の direct eslint 8.57.1。flat config 統一含む。GHSA `js-yaml` advisory が transitive 経由で残るのは eslint 8 chain が `@eslint/eslintrc → js-yaml@4.1.1` を要求するため）
- [ ] **mongoose 8 → 9 major up**（`packages/api` / `packages/collab` / `packages/plugin-search-mongo`。GHSA `ip-address` advisory が transitive 経由で残るのは mongoose 8 → mongodb 6.20 → socks 2.8.4 → ip-address@9.0.5 chain で、socks 2.8.7+ の ip-address 10.x 切替が引けないため）

---

## ✅ 完了済み（主なマイルストーン）

- **フェーズ1 ページ機能** — CRUD / list / portal / revision / bookmark / like / seen-by / comment / watch / trash / backlink / notification / user page / history
- **特定 revision への revert** — stale 帯の「この版に戻す」+ `POST /pages/revert-to-revision` + MCP `crowi_revert_to_revision`（非破壊・portal 対応。spec: `feature-revision-revert.md`）
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

---

## Notes（運用）

- main 直コミット（`commitStrategy: main-direct`）。push / PR は明示指示待ち
- 並行作業は `gw start <name>` → 完了後 `/integrate-worktree <name>`
- API は Hono、`/api/v2` prefix。contract 編集後は `pnpm --filter @crowi/api-contract build`
- state: `.migration-state/` / `.feature-state/`（root、gitignore 済）
- format/lint: pre-commit で biome format、pre-push で `pnpm lint` + `check:openapi`

## Operator runbooks

詳細手順は `apps/crowi-site/content/docs/{ja,en}/operations/` を参照。

- **Realtime collab**: api 同居。`WS_TOKEN_SECRET` 全レプリカ同一、multi-instance は `REDIS_URL` 必須
- **Storage driver 切替**: `crowi-admin rebuild storage copy` → `crowi.config.json` 変更 → 再起動
- **AWS 認証情報**: `/admin/plugins?name=@crowi/plugin-aws` で設定
