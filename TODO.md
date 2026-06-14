# TODO List

Crowi 2.0 (Express + Swig → Next.js + Hono)。**2.0.0-alpha1 リリース準備中**。
完了済みの実装詳細は git log / 各 RFC (`docs/rfcs/`) / spec (`.feature-state/specs/`) を参照。

---

## 🎯 Now — 2.0.0-alpha1 リリース準備

spec: `.feature-state/specs/feature-v2-alpha1-release-prep.md`（実本番=v1 DB への in-place アップグレード前提）

- [ ] **外部共有機能の削除** — admin/share トグル + `app:externalShare` config + admin/app 状態表示 + i18n。Share モデルは dormant 据え置き。LinkSharePopover（リンクコピー）は残す
- [ ] **ソーシャルログイン削除** — `google:*`/`github:*` config・config-sensitive・/me の googleId/githubId・profile 表示・admin の coming-soon 枠・i18n。認証ポリシー設定は残して不活性化。User schema は dormant 据え置き
- [ ] **通知設定メニュー削除** — admin サイドバーの stub + i18n のみ（通知本体は無改変）
- [x] **renameTree 移行** — `POST /pages/rename` に `include_descendants` 追加。`findListByStartWith`→`getPathMap`→`checkPagesRenamable`→`renameTree`（preserveUpdatedAt / 非ポータルのみ redirect / best-effort）でルート＋grant可視サブツリーを一括移動。`renamed_count` + 構造化 400 衝突。Web は switch 結線・件数トースト・衝突表示
- [ ] **prod build / runner 検証** — `pnpm build` で起動するか、特に `@crowi/runner` が prod build で plugin 解決できるか（環境固有の Lightsail 等は対象外）
  - [x] **runner-project 方式 Phase 1 done** — `@crowi/api` をプラグインフリーに戻し（11 ドライバの prod dep 同梱という Phase 4 stopgap を revert、SDK `@crowi/plugin-api` + core のみ）、モノレポ自身の reference runner project `apps/crowi-runner`（`@crowi/runner-app`, private, full=全 11 ドライバ）を新設。root の `crowi.config.json` を runner project へ移動し dev/prod の projectDir を一本化。dev は api dev script が cwd=`apps/crowi-runner` に切替え root `.env` を `--env-file-if-exists` で読込。Dockerfile / docker-compose は `@crowi/runner-app` の deploy ツリーから build/mount。`pnpm deploy --filter=@crowi/runner-app --prod` で 404-zero 検証済み（15 @crowi pkgs）。spec: `.feature-state/specs/feature-prod-runner-project.md`
  - [ ] **slim image + 外部 operator 向け doc** — slim（最小起動セット）は `@crowi/plugin-search-mongo`（search デフォルト driver）依存のため blocked-on `feature-plugin-search-mongo`。mongo-search 取込後に `IMPLICIT_DEFAULT_PLUGINS` への追加 + slim runner-app 新設を後続ステップで。手動 runner project 作成手順 + web デプロイ結線の doc 化は本タスク Phase 2（人間確認 gated）
- [x] **v1→v2 データ移行 (RFC-0008)** — migration framework 実装済み。`crowi-admin migrate plan|apply|status|list` + `rebuild renderer|search|backlink|storage copy`（共有 runner: dry-run / progress / 並列 / SIGINT）、boot-auto/preflight 二層化（`MIGRATION_PREFLIGHT_UNAPPLIED_POLICY` block/warn・block=全レプリカ fail-fast）、`migrationApplications` 監査ログ。migrations: page-status-default(boot) / wikilink-format(preflight・Yjs 無効化バグ修正) / user-unique-prepare(preflight・tombstone + plain unique index + E11000→USERNAME_TAKEN/EMAIL_TAKEN) / revisions-schema-unify(boot・type backfill)。詳細は git log / `docs/rfcs/0008-migration-framework.md`
- [ ] **version bump + tag** — `-dev` 正規化 → linked group を `2.0.0-alpha.0` へ（api-contract は 1.0.0 からジャンプ）→ changeset pre mode → CHANGELOG → git tag。npm publish はしない

---

## High Priority — 進行中

### Plugin Architecture (RFC-0001)
- [ ] Step 8: notifier (Slack) plugin 化（現在 `util/slack.ts` 直書き）
- [ ] Step 10: auth provider plugin 化 — Google/GitHub OAuth。alpha1 で一旦削除し、将来 plugin で復活
- [ ] 将来: encryption KeyProvider plugin (KMS 系)、S3 以外の attachment storage

### OAuth 2.0 (RFC-0010)
- [ ] Phase 5: admin による任意 OAuth クライアント登録 UI（Phase 1-4 は完了）

### 配布 / リリース (2.0.0 stable 時)
- [ ] **無印 `crowi` パッケージの整理** — v1.7.9 を残しつつ `crowi@2.0.0` を**デプロイ・クイックスタート / scaffolder**（`npx crowi init` で docker-compose + .env.sample 生成）へ格上げ。最低ラインで v1 を「移転」文言で `npm deprecate` + README 刷新。`@crowi/cli`(RFC-0012)/`@crowi/admin-cli` と役割を分離。前提: Docker image の CI publish。spec: `.feature-state/specs/feature-crowi-quickstart-package.md`
- [ ] **web image の API URL 実行時注入（汎用配布化）** — `crowi/crowi-web` を「ビルド時焼き込み」から「実行時注入」へ。同一オリジン既定（相対 `/api/v2` + Next rewrites proxy 宛先を `CROWI_API_URL` サーバ env 化 + WS は `window.location` 導出）、クロスオリジンは runtime-env escape hatch。**api(full/slim) は先行 publish 済み、web image はこの対応後に publish（案Y）**。spec: `.feature-state/specs/feature-web-image-runtime-config.md`
- [ ] **CI リリース自動化** — alpha.1 から GO 判断だけ人間・他は CI。npm は changesets/action(Version PR) + **Trusted Publishing(OIDC・secret 無し)**、ただし **pnpm 9 は OIDC 非対応 → pnpm10 or npm 経由 publish を選択**。`docker.yml` 新規で full/slim を multi-arch 自動 build+push（DOCKERHUB secret）。傘タグ `v*` でリリース結合、**plugin-only patch でも Docker 再ビルド**のポリシー。per-plugin 独立 patch は changeset で対応可（linked は api/web/contract のみ）。spec: `.feature-state/specs/feature-ci-release-automation.md`

### 管理画面 残 (フェーズ4)
- [ ] Slack channel 通知（一覧/編集 + page-path→channel mapping + Slack 統合設定）

### その他 残作業
- [ ] error code 細分化（comment/revision の `INVALID_REQUEST` を `MISSING_REQUIRED_FIELD` / `INVALID_OBJECT_ID` / `*_FAILED` に）
- [ ] Slack event endpoint（受信側 `/_api/slack/event`）
- [ ] web テスト基盤整備 + API coverage 強化

---

## バックログ — deferred refactor / advisory

merge 後の 3-agent simplify レビューで挙がった非ブロッキング改善。多くは git log の各 advisory コミットに詳細あり。一部は RFC-0006 前の `routes/ts-rest/` パス参照で陳腐化している点に注意。

- [ ] **WS 基盤の重複抽出**（notifications/presence/collab が 3-way 重複）— `attachWsNamespace()` + `createSignedWsTokenUtil()` を抽出。`resolve*WsUrl` も web 側で共通化
- [ ] **RFC-0003 collab advisory** — redis-url/ws-token util 重複、collab models 型付け（`as any` 撲滅）、Yjs update の insertMany batch 化、save-flow/on-load 並列化、preview LRU
- [ ] **RFC-0004 editor advisory** — autocomplete の COLLSCAN（text index/Atlas Search 要設計）、attachment fail helper / UploadIntent 共有（`runPageStatusMigration` の steady-state skip は RFC-0008 で page-status-default の index-backed isPending に移行済み）
- [ ] **RFC-0005 presence advisory** — presence heartbeat の pipeline 化、token util 抽出（WS 基盤と同件）
- [ ] **feature 別 advisory** — inline-attachment regex/variant 分割、email-plugin の mail-token verify ヘルパ + 認証フォーム hook 化、shared error-codes i18n single-source、editor session-reauth 堅牢化、watch-autosubscribe の findOneAndUpdate 1 クエリ化 + fan-out クエリ削減
- [ ] **RFC-0002 renderer 残** — Phase 6.1 Mermaid renderer、Phase 7+ GitHub Embed plugin + AuthContext 本実装、pageEvent payload enrichment、mention dispatch N+1、renderedAst size cap
- [ ] **monorepo restructure follow-ups** — catalog 化候補の積み残し、compose healthcheck、devDeps mirror が tarball に prerelease pin で残る問題、dev/prod parity test、`.claude/agents/feature-*` の multi-phase 対応
- [ ] **crypto Phase 3（将来）** — KeyProvider pluggable 化（AWS/GCP KMS）。lookup-key 系 secret（`Share.secretKeyword`）の hash 化（apiToken は廃止済み、Share は alpha1 で削除予定）
- [ ] **RFC-0008 follow-ups** — `rebuild renderer` / `rebuild backlink` は dispatcher 登録のみ（NOT_YET 骨組み）→ 本実装。`crowi-admin watcher backfill`（main 由来の冪等 backfill）を framework の `rebuild`/`migrate` task へ取り込み統一。RFC ドキュメントを実装に追従（Phase 6 の layer=boot 採用、uniqueness の tombstone 方式確定など Draft からの差分）
- [ ] **renameTree merge advisory** — `page.ts` の subtree-rename が 2 ルート（`/pages/rename` の include_descendants 分岐 と `/pages/rename-subtree`）でほぼ重複 → 共通 subtree パイプラインを Model static か handler helper に集約。`checkPagesRenamable` の N+1（path 毎 `exists`+`findPageByPath` → `$in` で 1 クエリ化、behavior-sensitive）。web 側 conflict の型安全 discriminator（OpenAPI 生成 union を使う）。partial 失敗時に成功 path を返す/再試行契約。locale-bridge ↔ LocaleSync の責務文書化。`RENAME_TREE_CONCURRENCY=8` の env 化。`renameTreeFailedBody` を `_helpers/errors.ts` へ

---

## ✅ 完了済み（主なマイルストーン）

- **フェーズ1 ページ機能** — CRUD / list / portal / revision / bookmark / like / seen-by / comment / watch / trash / backlink / notification / user page / history
- **RFC-0001 Plugin Architecture** — plugin-api / PluginManager（boot topo-sort + auto-load）/ storage(local, s3) / search(ES, OpenSearch) driver plugin / schema-driven admin auto-form / sidebar 注入
- **検索** — 全文検索 UI（`/_search` + global search + suggestion）+ admin 検索ステータス + ES 9.4.0（docker-compose 復帰）/ OpenSearch driver。index 再構築は `crowi-admin rebuild search`（RFC-0008 framework）に集約（`rebuild backlink` は骨組み）
- **認証 / アカウント** — login / register / installer / 招待受諾（invite/accept）/ メール確認・変更 / パスワードリセット
- **RFC-0002 Renderer** — TOC + stale-revision / SSR HTML 化 + Shiki / Reservation + cache / crowi-legacy + wikilink migrator / PlantUML + emoji + KaTeX / mention dispatch
- **RFC-0003 Realtime collab** — Yjs/Hocuspocus を api 同居 attach、wsToken、save flow + RFC-0002 統合、PageYjsUpdate compaction、20-user cap + force-reload、awareness/save UI、multi-server redis
- **RFC-0004 Editor UX** — toast、draft status、autocomplete（@mention / [[wikilink]]）、attachment upload（paste / D&D）
- **RFC-0005 Presence** — live presence row、メタチップ行、likers
- **RFC-0010 OAuth (Phase 1-4)** — scope 基盤 / PAT（legacy apiToken 廃止）/ Authorization Code + PKCE + discovery / Device grant
- **管理画面（フェーズ4）** — app / security / auth / mail / share / storage / users + sensitive config の at-rest 暗号化（crypto status / reencrypt UI）
- **monorepo restructure** — workspace protocol / pnpm catalog / `@crowi/tsconfig` / api・web を `packages/` へ / `@crowi/runner` 切り出し / Dockerfile + standalone / changesets + CI publish workflow
- **エディタ / UI** — CodeMirror 6 + 2-column preview、階層ページサイドバー（全ページ表示）、create-page モーダル（Tab 補完）、page-path の `+` スペースエンコード、boot progress UI、通知のリアルタイム WS invalidation、watch ベース通知一本化
- **ダークモード（theme-dark-mode）** — next-themes（class 戦略・system 既定・FOUC 対策）+ ヘッダー/サインインのトグル、`.dark` トークン起動。Shiki dual-theme（CSS 変数）+ RENDERER_PIPELINE_VERSION bump、CodeMirror dark theme（theme compartment）、diff / sonner のテーマ連動。`User.theme` + `PATCH /me/theme` + `ThemeSync` で端末間同期、PlantUML 等の固定色 SVG をニュートラル背景ラッパで包む、AA コントラスト監査
- **インフラ / 品質** — mongoose 6→8 upgrade、Biome + lefthook、turbo `^build`、bcrypt 移行、i18n（paraglide）、installer 移行
- **legacy 除去（RFC-0006）** — Express routes / controllers / form validators / Swig views / ts-rest 層 / `apiResponse.ts` をすべて削除済み
- **web エラー画面 / 接続レジリエンス** — `apiV2Fetch` + `refreshAccessToken` に AbortController タイムアウト（既定 20s, `NEXT_PUBLIC_API_TIMEOUT_MS` で override、`AbortSignal.any` で caller signal 合成、timeout は `crowi:timeout` reason で cancel と識別）/ `app/error.tsx`・`app/global-error.tsx` エラーバウンダリ / `QueryCache.onError`→module-level ref→`ConnectionProvider` 集約（5xx→serverError / network・timeout→networkError、401 除外）/ react-query retry を 4xx 即エラー・5xx・network 少回数（2）に。spec: `.feature-state/specs/feature-web-error-screens.md`。手動確認: ① API 停止→ネットワークバナー ② 応答ハング→20s でタイムアウト→エラー ③ render throw→`error.tsx` のエラーカード + 再読み込み

---

## Notes（運用）

- main 直コミット（`commitStrategy: main-direct`）。push / PR は明示指示待ち
- 並行作業は `gw start <name>` で worktree → 完了後 `/integrate-worktree <name>` で合流
- API は Hono、`/api/v2` prefix。contract 編集後は `pnpm --filter @crowi/api-contract build`
- state: `.migration-state/` / `.feature-state/`（root、gitignore 済）
- format/lint: pre-commit で biome format、pre-push で `pnpm lint`（errors=0）+ `check:openapi`

## Operator runbooks

詳細手順は `apps/crowi-site/content/docs/{ja,en}/operations/` を参照。

- **Realtime collab**: Hocuspocus は api プロセス同居。`WS_TOKEN_SECRET` は全レプリカ同一値、multi-instance は `REDIS_URL` 必須、`COLLAB_MAX_EDITORS_PER_PAGE`（default 20）
- **Storage driver 切替**: `crowi-admin rebuild storage copy --from <a> --to <b>`（dry-run 可）→ `crowi.config.json:storage.driver` 変更 → 再起動 → `/admin/storage` で確認。旧データは温存
- **AWS 認証情報**: 旧 `upload:aws:*` のコア設定キーと boot-time 自動移行は廃止済み。`/admin/plugins?name=@crowi/plugin-aws` で設定
