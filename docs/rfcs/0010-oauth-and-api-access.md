# RFC-0010: OAuth 2.0 Foundation & Scoped API Access

- **Status**: Draft (Round 1 — design proposal)
- **Author**: (you)
- **Created**: 2026-05-29
- **Depends on**: RFC-0006 (Hono Integration) — JWT auth, `createJwtAuth`
- **Related**: RFC-0001 (Plugin Architecture) Step 10 — auth provider
  plugin 化 (Google / GitHub OAuth) は *inbound* の話。本 RFC は Crowi
  自身が OAuth **プロバイダ** になる *outbound* の話で、別軸。

## Summary

Crowi 自身を OAuth 2.0 認可サーバーにし、Crowi CLI / SDK などの外部
クライアントが「ユーザーとして」スコープ付きで API を叩けるようにする。

3 つの取得経路を提供する:

1. **Authorization Code + PKCE** — CLI/ネイティブアプリの標準。ブラウザ
   同意 → loopback callback で code → token 交換。
2. **Device Authorization Grant** — ブラウザを開けない headless / CI /
   remote shell 向け。CLI が `user_code` + URL を表示しユーザーが別デバイス
   で承認。
3. **Personal Access Token (PAT)** — web UI から scope + 期限付きで手動
   発行。スクリプト向けの簡易経路で、**legacy `apiToken` の直接の後継**。

access token は scope を claim に持つ JWT (stateless)、refresh token は
DB 保存で失効・ローテーション可能。既存の web セッション JWT はそのまま
「全 scope」扱いとして共存する。

legacy `apiToken` (scope/期限なし、SHA-256) は本 RFC で **完全廃止**。
fallback は持たない。

## Motivation

- 現状ユーザーが外部から API を使う手段は `User.apiToken` のみ。これは
  scope も期限もなく、漏洩時の影響が全権限・無期限という危険なもの。
- CLI/SDK で「ログイン → token 取得 → ユーザーとして振る舞う」を、最小
  権限・取り消し可能な形で実現したい。
- web UI のページ編集は collab (RFC-0003) 経由だが、外部クライアントは
  collab を介さず Markdown を REST で投入できる必要がある (既に
  `PUT /pages` が満たす。本 RFC では scope を被せるだけ)。

## Design decisions (確定済み)

| 論点 | 決定 |
|---|---|
| フロー | Auth Code + PKCE / Device Flow / PAT の 3 本 |
| access token | scope 入り JWT (stateless)、`jwt.ts` を拡張 |
| refresh token | DB 保存・ハッシュ・ローテーション・失効可能 |
| scope 粒度 | リソース別 read/write + umbrella `read` / `write` |
| クライアント | v1 は first-party 固定 client のみ。ただし `OAuthClient` を最初から model 化し、admin による任意 app 登録 (confidential client) を後方拡張で追加可能にする |
| admin API | v1 では OAuth scope の対象外 (web セッションのみ)。`admin:*` scope は予約だけして未実装 |

## Scope catalog

リソースカテゴリ × `read` / `write`。`write` は同一リソースの `read` を
含意する (GitHub の repo write→read と同様)。umbrella `read` は全
`*:read`、`write` は全 `*:write` (+ 全 read) を含意する。

| scope | 対象ハンドラ |
|---|---|
| `pages:read` / `pages:write` | page, revision, draft, backlink, search, autocomplete |
| `comments:read` / `comments:write` | comment |
| `bookmarks:read` / `bookmarks:write` | bookmark |
| `attachments:read` / `attachments:write` | attachment |
| `notifications:read` / `notifications:write` | notification |
| `profile:read` / `profile:write` | me, user |
| (予約) `admin:read` / `admin:write` | admin/* — v1 では発行不可 |

scope の正準リストは `packages/api-contract/src/schemas/oauth.ts` の
`SCOPES` 定数 1 箇所に置き、API/web/同意画面が共有する。

### 含意ルール (scope 充足判定)

要求 scope `R` がトークン scope 集合 `S` で満たされるのは:

- `R ∈ S`、または
- `R = "x:read"` かつ `"x:write" ∈ S`、または
- `R = "x:read"` かつ (`"read" ∈ S` または `"write" ∈ S`)、または
- `R = "x:write"` かつ `"write" ∈ S`

## Token model & middleware

### access token (JWT 拡張)

`util/jwt.ts` の payload に OAuth 用フィールドを追加:

```
{
  userId, email,
  type: 'oauth_access',          // 既存 web セッションは 'access' のまま
  scope: 'pages:read pages:write', // space-delimited (RFC 6749)
  client_id: 'crowi-cli'
}
```

- web セッション token (`type: 'access'`) = scope claim なし → **全 scope**
  として扱う (UI の挙動は不変)。
- OAuth token (`type: 'oauth_access'`) = `scope` claim の集合に限定。

### 統一 Bearer 認証 (`createJwtAuth` 拡張)

`middleware/auth.ts` の `createJwtAuth` を、3 種の Bearer を受理するよう
拡張する:

1. JWT (`type: 'access'`) → web セッション。`authScopes = ALL`。
2. JWT (`type: 'oauth_access'`) → `authScopes = parse(scope)`。
3. `crowi_pat_` プレフィックスの不透明トークン → SHA-256 で hash 化して
   `PersonalAccessToken` を検索。`authScopes = record.scopes`、期限切れ/
   失効を弾き、`lastUsedAt` を更新。

いずれも `c.set('user', user)` に加え `c.set('authScopes', Set<string>)`
と `c.set('authContext', { kind, clientId? })` をセットする。

### `requireScope(scope)` middleware

新規。`c.get('authScopes')` を含意ルールで判定し、不足なら
`403 INSUFFICIENT_SCOPE` (`WWW-Authenticate: Bearer error="insufficient_scope"`)
を返す。既存ルートに被せる:

```
app.use('/pages/*', createJwtAuth(crowi))      // 既存
// 各 openapi route の前段、または method 別に:
//   GET    → requireScope('pages:read')
//   POST/PUT/DELETE → requireScope('pages:write')
```

web セッションは `authScopes = ALL` なので常に通過し、挙動は不変。

## Mongoose models (新規)

```
OAuthClient
  clientId        string (unique)        // 'crowi-cli' を seed
  name            string
  type            'public' | 'confidential'
  secretHash?     string                 // confidential のみ
  redirectUris    string[]               // loopback は host 一致でポート任意許可
  allowedScopes   string[]
  firstParty      boolean
  trusted         boolean                // true でも v1 は consent 表示
  createdAt

OAuthAuthorizationCode  (TTL ~60s)
  codeHash, clientId, userId, scopes[],
  codeChallenge, codeChallengeMethod ('S256'),
  redirectUri, expiresAt, consumedAt?

OAuthDeviceCode  (TTL ~10min)
  deviceCodeHash, userCode (8桁 BCDFGHJKLMNPQRSTVWXZ 系),
  clientId, requestedScopes[], grantedScopes[]?,
  status 'pending'|'approved'|'denied',
  userId?, expiresAt, interval, lastPolledAt?

OAuthRefreshToken
  tokenHash, clientId, userId, scopes[],
  expiresAt, createdAt, revokedAt?, rotatedTo?  // reuse 検知で chain 失効

PersonalAccessToken
  tokenHash, userId, name, scopes[],
  expiresAt? (null=無期限可), lastUsedAt?, createdAt, revokedAt?
```

token 本体は全て SHA-256 ハッシュで保存 (legacy apiToken と異なり平文
検索を要する設計を排除)。

## Endpoints

### OAuth 標準 (公開ルート)

| method/path | 役割 |
|---|---|
| `POST /oauth/token` | grant_type: `authorization_code` / `refresh_token` / `urn:ietf:params:oauth:grant-type:device_code`。access(JWT)+refresh+expires_in+scope を返す |
| `POST /oauth/revoke` | refresh token / PAT の失効 (RFC 7009) |
| `POST /oauth/device/authorize` | device_code, user_code, verification_uri(_complete), interval, expires_in |
| `GET /.well-known/oauth-authorization-server` | discovery メタデータ (RFC 8414)。issuer / token / authorization / device / revocation endpoint、`scopes_supported`、`code_challenge_methods_supported: ['S256']`、`grant_types_supported`。CLI/SDK が endpoint を自動発見でき、将来の任意 app 対応にも効く |

### 同意・確定 (JWT 認証下 = ログイン済み web ユーザー)

| method/path | 役割 |
|---|---|
| `POST /oauth/authorize` | 同意画面が呼ぶ。PKCE challenge + scopes を検証し authorization code を発行、redirect_uri を返す |
| `POST /oauth/device/verify` | device user_code 入力 + 承認/拒否 |

> `GET /oauth/authorize` 相当の「同意画面」は Hono ではなく **Next.js
> ページ** が担う (下記)。Hono 側は code 発行 API のみを持つ。

### PAT 管理 (`/me` 配下、legacy `/me/apiToken` を置換)

| method/path | 役割 |
|---|---|
| `GET /me/access-tokens` | 一覧 (token 本体は返さない、メタのみ) |
| `POST /me/access-tokens` | name + scopes + expiresAt 指定で発行。**作成時のみ平文を返す** |
| `DELETE /me/access-tokens/:id` | 失効 |

## Web (Next.js) — `(auth)` group

- `(auth)/oauth/authorize` — 同意画面。query (`client_id` / `scope` /
  `redirect_uri` / `code_challenge` / `state`) を読み、クライアント名と
  要求 scope を read/write のチェックリストで表示 → 承認で
  `POST /api/v2/oauth/authorize` → 返ってきた redirect_uri へ遷移。
- `(auth)/oauth/device` — `user_code` 入力 → 同上の同意 →
  `POST /api/v2/oauth/device/verify`。
- 設定画面 (`(auth)/settings/access-tokens` 等) — PAT の発行/一覧/失効 UI。

## CLI フロー (参考)

```
# Auth Code + PKCE
crowi login
  → verifier/challenge 生成、loopback サーバ起動 (127.0.0.1:<rnd>)
  → ブラウザで /oauth/authorize?...&code_challenge=...&scope=pages:write+...
  → 同意 → callback?code=...&state=...
  → POST /oauth/token (code + verifier) → token 保存 (~/.config/crowi)

# Device flow (ブラウザ無し)
crowi login --device
  → POST /oauth/device/authorize
  → "https://wiki/oauth/device に行き ABCD-1234 を入力" と表示
  → interval で POST /oauth/token をポーリング → approved で token 取得
```

## 外部 Markdown 投入 (ページ編集)

新規エンドポイントは不要。`pages:write` を持つトークンで既存
`PUT /api/v2/pages` (`Page.updatePage` → `Revision.prepareRevision` →
`pushRevision`) / `POST /api/v2/pages` を叩く。collab (Y.Doc) を経由せず
revision を直接作る経路で、RFC-0009 の text-diff 設計上も外部編集は次回
save が前 body との diff を取るだけで特別扱い不要 (RFC-0009 OQ-F)。

競合検出は既存の `revision_id` チェック (`Page.isUpdatable`) をそのまま
使う。SDK は取得した `revision_id` を更新時に送ること。

## Legacy `apiToken` の廃止 (fallback なし)

削除対象:

- `models/user.ts`: `apiToken` フィールド、`generateApiToken`、
  `updateApiToken`、`findUserByApiToken`
- `middleware/auth.ts`: 未使用の `accessTokenParser`、cookie 以外の
  legacy 経路
- `handlers/me.ts`: `GET/POST /me/apiToken`
- 対応する api-contract route / web の API token UI

移行: 既存 `apiToken` 利用者は PAT 再発行が必要 (本番未投入のため互換層
不要 — project memory `feedback_api_v2_no_backcompat` に整合)。

## Security considerations

- **PKCE 必須** (public client)。`code_challenge_method=S256` のみ許可。
- **redirect_uri**: first-party CLI は loopback (`127.0.0.1` / `localhost`、
  任意ポート) のみ許可。それ以外は完全一致。
- **refresh rotation + reuse 検知**: 使用済み refresh の再提示で chain
  全体を失効。
- access token は短命 (既定 1h)。失効は refresh / PAT 側で行う (access
  は stateless なので即時失効はしない — 短命で許容)。
- token は全て保存時ハッシュ化。発行時平文は一度だけ返す。
- consent 画面で scope を read/write 単位で明示。
- `INSUFFICIENT_SCOPE` は 403 + `WWW-Authenticate` で返す。
- **公開 URL は `CLIENT_URL` 起点に固定**: discovery の `issuer` /
  `authorization_endpoint` / token・revocation・device endpoint、および
  device flow の `verification_uri` は、信頼できる `CLIENT_URL` (web
  クライアントの公開オリジン) から組み立てる。リクエストの `Host` /
  `X-Forwarded-Host` ヘッダからは導出しない — Host は攻撃者が操作でき、
  forged Host で discovery / `verification_uri` を汚染して被害者を攻撃者
  オリジンへ誘導できてしまうため。`app:url` は Host 由来で信頼しない
  (廃止)。API endpoint (`token` 等) は既定構成で `/api/v2` が同一オリジンに
  reverse-proxy される前提で `{CLIENT_URL}/api/v2/...`。

## Implementation phases

1. **scope 基盤** — `SCOPES` catalog (api-contract)、`jwt.ts` claim 拡張、
   `createJwtAuth` を scope-aware 化、`requireScope` middleware、既存ルート
   に method 別 scope 付与。web セッションは全 scope で挙動不変。
2. **PAT** — `PersonalAccessToken` model + `/me/access-tokens` + web UI。
   **legacy `apiToken` 削除**。
3. **Auth Code + PKCE** — `OAuthClient` model + seed、
   `OAuthAuthorizationCode`、`OAuthRefreshToken` (rotation)、
   `POST /oauth/token` (authorization_code / refresh_token)、
   `POST /oauth/revoke`、`GET /.well-known/oauth-authorization-server`
   (discovery)、Next.js 同意画面。
4. **Device flow** — `OAuthDeviceCode` model、`device/authorize` +
   token endpoint の device grant + `device/verify` + web 入力画面。
5. **(future) admin client 登録 UI** — confidential client / redirect_uri
   管理。RFC-0001 の plugin auth (inbound) とは別 admin セクション。

各 phase は changeset 1 つ (`minor`、`@crowi/api` + `@crowi/api-contract`、
web 変更があれば `@crowi/web`)。

## Resolved questions

- **OQ-A (resolved)**: access token の即時失効は **v1 では不要**。「短命
  (既定 1h) + refresh / PAT 側での失効」で十分とする。access は stateless
  なまま (DB introspection は導入しない)。
- **OQ-D (resolved)**: discovery メタデータ
  (`GET /.well-known/oauth-authorization-server`, RFC 8414) を **v1 で
  提供する**。phase 3 に含める。

## Open questions

- **OQ-B**: scope の含意で「`write` は同一リソース `read` を含む」を
  採用したが、明示2つ要求 (read を別途必須) にするか。→ 含意で進める想定。
- **OQ-C**: PAT に `admin:*` を許すか。v1 は不可 (admin は web セッション
  のみ) で予約だけ。
