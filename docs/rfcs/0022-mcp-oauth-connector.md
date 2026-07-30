# RFC-0022: OAuth integration for external MCP connectors

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-07-29
- **Depends on**:
  - RFC-0006 (Hono Integration) — discovery, registration, authorization,
    token, administration, and MCP endpoints use Hono and the shared
    API-contract/OpenAPI pipeline.
  - RFC-0010 (OAuth 2.0 Foundation & Scoped API Access) — this RFC extends
    Crowi's authorization-code + PKCE flow, refresh-token rotation, scoped
    access tokens, consent screen, and DB-backed `OAuthClient`.
  - RFC-0011 (Crowi MCP Server) — this RFC completes the OAuth-for-MCP work
    deferred there without changing the Streamable HTTP transport.
  - The public API prefix migration from `/api/v2` to `/api` — it must land
    before this RFC is implemented so Crowi publishes one canonical MCP
    resource identifier and token audience.
- **Related**:
  - RFC-0012 (Crowi CLI) — seeded first-party OAuth clients remain valid and
    are not converted into dynamic MCP clients.
  - RFC-0019 (TOTP Two-Factor Authentication) — establishes standalone
    MongoDB as a supported default and rejects multi-document transactions as
    a required correctness mechanism.
  - RFC-0021 (Page History for Non-content Changes) — provides the bounded
    outbox and repair precedent used for cross-document recovery on standalone
    MongoDB.

## §0 Summary

Crowi will support the URL-only connection flow used by ChatGPT custom
connectors and other standards-compliant remote MCP clients. A client starts
with Crowi's public MCP URL, discovers OAuth through RFC 9728 Protected
Resource Metadata, dynamically registers as a public client, and completes an
authorization-code flow with S256 PKCE.

The first implementation is standards-complete OAuth plus public Dynamic
Client Registration (DCR):

- every MCP `401` carries an RFC 6750 `WWW-Authenticate` challenge with
  `resource_metadata`;
- RFC 9728 metadata identifies Crowi's canonical protected resource and
  authorization server;
- RFC 8707 `resource` is preserved through authorization, code exchange,
  refresh, JWT audience, and MCP validation;
- public DCR creates secretless, untrusted clients in the existing
  `OAuthClient` collection;
- the connector selects its required scope set before authorization; the
  interoperable default is `pages:read pages:write`, while administrators may
  cap external clients at read-only;
- administrators control enablement, DCR activation, scope caps, abuse
  limits, inventory, and revocation from a dedicated **AI integrations**
  area; and
- users can inspect and revoke their own connected-client grants.

DCR is selected for implementation cost, not because the MCP specification
prefers it. The current MCP authorization specification says authorization
servers **SHOULD** support Client ID Metadata Documents (CIMD) and **MAY**
support DCR. Crowi deliberately starts with DCR because a durable client
record maps to the required approval, revocation, quota, and
connection-inventory lifecycle. This is not a dependency shortcut: the locked
`@hono/mcp` DCR code is only a types/wire-shape reference. Its generated
identifiers, generated secrets, public-client admission, and global limiter
are not suitable for this RFC. Crowi must implement its own cryptographic
identity generation, public-only validation, source-aware fail-closed
limiting, quota reservation, lifecycle, and policy integration. CIMD would
instead add a hardened outbound metadata resolver plus the same local policy
record. The choice is therefore a present implementation-cost decision after
pricing both complete subsystems, not a standards ranking or a claim that DCR
is already implemented by a dependency.

All client lookup is centralized in:

```ts
resolveOAuthClient(clientId: string): Promise<OAuthClientResolution>
```

Only a normalized internal client shape leaves this boundary. No other OAuth
code reads `OAuthClient` directly or assumes that `client_id` is an opaque
database key. That constraint is essential because a DCR `client_id` is an
opaque generated value while a CIMD `client_id` is a URL. Adding CIMD later
must replace or extend this one resolver rather than rewrite validation,
authorization, token, consent, and administration paths.

Crowi's default MongoDB is standalone. The implementation therefore uses
single-document compare-and-set (CAS), bounded per-operation outbox state,
deterministic identifiers, idempotent materialization, and repair workers. It
does not require a replica set or multi-document transaction.

The existing MCP transport is already compatible. Crowi uses
`@hono/mcp`'s stateless, per-request `StreamableHTTPTransport`
(`packages/api/src/mcp/attach.ts:16-20,101-119`). This RFC does not add a
legacy `/sse` endpoint.

## §1 Background and motivation

### §1.1 Crowi has OAuth and MCP but not their interoperable boundary

RFC-0010 provides:

- authorization code with S256 PKCE;
- refresh-token rotation;
- scoped JWT access tokens;
- a consent screen;
- RFC 8414 Authorization Server Metadata; and
- a DB-backed `OAuthClient`.

RFC-0011 provides page and search tools over Streamable HTTP. The endpoint
currently applies the shared `createJwtAuth(crowi)` middleware and dispatches
tool calls to scope-protected Hono routes
(`packages/api/src/mcp/attach.ts:55-119`,
`packages/api/src/mcp/server.ts:67-99,132-159`).

Those foundations do not yet let a generic external MCP client bootstrap:

1. MCP authentication failures return `401` without `WWW-Authenticate`.
2. Crowi has no RFC 9728 Protected Resource Metadata endpoint.
3. Authorization and token schemas do not accept RFC 8707 `resource`
   (`packages/api-contract/src/schemas/oauth-endpoints.ts:59-66,94-115`).
4. Authorization codes and refresh tokens do not retain a resource
   (`packages/api/src/models/oauth-authorization-code.ts:26-38`,
   `packages/api/src/models/oauth-refresh-token.ts:30-41`).
5. OAuth access JWTs have scope and client id, but no protected-resource
   audience (`packages/api/src/util/jwt.ts:15-37,114-160`).
6. The authorization page does not preserve `resource` through consent
   (`packages/web/src/app/(auth)/oauth/authorize/page.tsx:39-68`).
7. The only clients are boot-seeded first-party clients. The model explicitly
   says that no registration UI or endpoint exists
   (`packages/api/src/models/oauth-client.ts:5-48`,
   `packages/api/src/util/oauth-client-seed.ts:33-75`).

A discovery-only patch would merely move the failure to client resolution or
audience validation. The release unit must include discovery, client
onboarding, resource binding, least-privilege consent, and revocation.

### §1.2 The first `401` is part of the public protocol

An MCP client begins OAuth discovery at the protected resource. It follows the
`resource_metadata` URL in the Bearer challenge and then reads
`authorization_servers` from the protected-resource document.

Crowi's existing test asserts only the status:

```ts
const res = await callMcp(null, {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
});
expect(res.status).toBe(401);
```

This is `packages/api/src/mcp/mcp.test.ts:85-87`. The exact challenge becomes
an endpoint contract and a regression test.

### §1.3 The generic connector flow needs dynamic client onboarding

ChatGPT supports CIMD, DCR, and predefined clients. Supporting all three does
not itself select one. The generic custom connector flow starts with the MCP
URL and does not require an operator to copy a client id or secret into the
connector. Crowi also has no manual client-registration UI.

Public DCR is the first implementation for three concrete reasons:

1. The repository resolves `@hono/mcp` to `0.3.0` and
   `@modelcontextprotocol/sdk` to `1.29.0`
   (`pnpm-lock.yaml:265-276`). Those installed packages include DCR handlers,
   protected-resource metadata routing, and RFC 9728 types. They do not
   provide a Crowi-ready server-side CIMD resolver.
2. Neither option is intrinsically the lighter design. A safe CIMD resolver requires
   SSRF protection, DNS pinning, single-flight fetches, negative caching,
   per-host concurrency limits, bounded responses, and fail-closed behavior.
   DCR instead requires rate limits, registration quotas, lifecycle cleanup,
   and abuse visibility. Both are real subsystems.
3. DCR maps directly to Crowi's existing DB-backed `OAuthClient`. This is a
   lifecycle fit, not reuse of the installed handler. CIMD has no
   durable client lifecycle of its own, but Crowi still needs local policy,
   revocation, approval, audit, and connection visibility. That requires a
   shadow/policy record in addition to the metadata resolver.

The asymmetry in the specification remains explicit: CIMD is `SHOULD`, while
DCR is `MAY`. CIMD-only is evaluated independently in §14.

### §1.4 External AI access is an instance policy

External MCP clients receive content and may eventually change pages as the
authorizing user. Different deployments need different policies:

- a personal instance may automatically activate strict public registrations;
- an organization may require administrator approval;
- a sensitive instance may disable new registration while preserving existing
  approved connections; or
- an incident response may disable all external clients immediately.

These are administrator settings, not constants embedded in OAuth handlers.

## §2 Goals and non-goals

### §2.1 Goals

- Let ChatGPT and another conforming MCP client begin with only Crowi's public
  MCP URL.
- Return RFC 9728 metadata and an RFC 6750 challenge from the protected
  resource.
- Bind codes, refresh tokens, and access tokens to the canonical MCP resource
  using RFC 8707.
- Validate issuer and audience at the MCP resource.
- Support public, S256-only DCR without issuing a client secret.
- Centralize every OAuth client lookup behind one CIMD-ready resolver.
- Keep `client_id` syntax unconstrained by the DCR storage representation.
- Require the client to choose `pages:read` or `pages:read pages:write`
  before authorization; default connector documentation and compatibility
  fixtures use the complete read/write set.
- Let administrators control the external-client master switch, all three DCR
  activation modes, maximum scope, abuse controls, client lifecycle, and
  user/client connection visibility.
- Let users inspect and revoke their own grants.
- Make grant, client, and master-switch revocation effective for the next
  request, including an already issued access JWT.
- Preserve PAT behavior and seeded first-party OAuth clients.
- Support a trusted split-origin MCP URL without trusting request host
  headers.
- Work correctly on standalone MongoDB.
- Keep external URL construction independent of the public API prefix.

### §2.2 Non-goals

- Implementing CIMD in the first release.
- Advertising `client_id_metadata_document_supported` before CIMD exists.
- Fetching arbitrary client metadata URLs in the first release.
- Adding legacy HTTP+SSE or a separate `/sse` endpoint.
- Supporting confidential dynamic clients or issuing client secrets.
- A general UI for manually preregistering arbitrary OAuth applications.
- Dynamic native-app callbacks, custom URI schemes, or loopback HTTP redirect
  URIs. Existing seeded first-party exceptions remain unchanged.
- Adding new MCP tools or scopes beyond the current page/search surface.
- Treating ChatGPT action confirmation as a substitute for Crowi scope,
  consent, or administrator policy.
- Deriving a public issuer, resource, or metadata URL from request headers.
- Keeping `/api/v2` as a second MCP audience after the prefix migration.
- Requiring a MongoDB replica set or multi-document transaction.
- Defining tool-result OAuth upscoping without a proven client-specific
  transport contract.

## §3 Decision and end-to-end flow

The normative path is DCR-first:

1. The client calls the public Streamable HTTP MCP URL without credentials.
2. Crowi returns `401` with `WWW-Authenticate` and `resource_metadata`.
3. The client fetches Protected Resource Metadata.
4. It fetches Authorization Server Metadata and discovers the DCR endpoint.
5. It registers a public client, receiving an opaque `client_id`.
6. Crowi resolves that id only through `resolveOAuthClient`.
7. The client requests either `pages:read` or `pages:read pages:write` and
   the canonical `resource`, using S256 PKCE. The interoperable connector
   default is the complete read/write set.
8. Crowi displays consent and binds the resource to the code.
9. Code exchange repeats the resource and yields an audience-bound access
   token plus a rotating refresh token.
10. The client uses the access token on MCP. Crowi accepts only explicit
    Bearer PATs or MCP-bound OAuth access tokens.
11. A tool succeeds when the selected grant has its required scope. A
    read-only token calling a write tool receives an ordinary MCP tool error,
    not an OAuth upscoping instruction.
12. A client needing writes reconnects through its supported OAuth setup flow
    and requests the complete set; Crowi displays that authority at consent.
13. User, administrator, client, and global revocation are enforced at the
    next request through durable status fences.

No discovery document advertises CIMD in this release. No authorization path
implements a hidden CIMD special case.

## §4 Trusted public URLs and discovery

### §4.1 URL builders

One module owns three values:

| Value | Trusted source | Example after prefix migration |
|---|---|---|
| Authorization Server issuer | normalized `CLIENT_URL` / `crowi.getBaseUrl()` | `https://wiki.example.com` |
| Canonical MCP resource | normalized `MCP_PUBLIC_URL`, otherwise issuer + public API prefix + `/mcp` | `https://wiki.example.com/api/mcp` |
| Protected Resource Metadata URL | canonical MCP resource origin + `/.well-known/oauth-protected-resource` | `https://wiki.example.com/.well-known/oauth-protected-resource` |

`MCP_PUBLIC_URL` is a full absolute MCP URL. In production it must:

- use `https`;
- contain no username, password, query, or fragment;
- identify the externally reachable Streamable HTTP endpoint; and
- normalize to a no-trailing-slash resource identifier.

Loopback development may use `http`. External OAuth remains disabled when
`CLIENT_URL` or `MCP_PUBLIC_URL` is invalid. The AI integrations page shows
the resolved issuer, resource, and metadata URL read-only.

Request `Host`, `X-Forwarded-Host`, and similar headers never participate.
This follows the existing OAuth metadata boundary in
`packages/api/src/hono/handlers/oauth.ts:168-181,403-425`.

For split origins:

```text
CLIENT_URL=https://wiki.example.com
MCP_PUBLIC_URL=https://mcp.example.net/api/mcp
```

the resource metadata is served on `mcp.example.net` and names
`https://wiki.example.com` in `authorization_servers`.

The public metadata, DCR, authorization, token, device-authorization, and MCP
routes have an explicit connector CORS policy. It is configured as a bounded
allow-list of connector origins (including the configured MCP origin where a
browser client requires it), handles preflight, and exposes
`WWW-Authenticate` on responses that may challenge a browser client. It is
not inherited accidentally from the web `CLIENT_URL` CORS policy. Wildcard
origins are not used for credentialed browser requests.

### §4.2 Protected Resource Metadata

The API serves one RFC 9728 representation at:

- `GET /.well-known/oauth-protected-resource`; and
- `GET /.well-known/oauth-protected-resource{canonical-resource-path}`.

The second route is a discovery alias, not another audience. For the
post-migration default it is
`/.well-known/oauth-protected-resource/api/mcp`.

```json
{
  "resource": "https://wiki.example.com/api/mcp",
  "authorization_servers": ["https://wiki.example.com"],
  "scopes_supported": ["pages:read", "pages:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Crowi MCP"
}
```

`pages:write` is omitted when the administrator scope cap is read-only. The
document advertises only scopes used by current MCP tools.

### §4.3 MCP `401` challenge

An MCP-specific middleware wraps the entire authentication boundary and adds
a challenge to every authentication `401`, including:

- missing or malformed Authorization;
- unknown, expired, or revoked PAT;
- invalid or expired JWT;
- wrong OAuth issuer or audience;
- a revoked or disabled client;
- a revoked grant; and
- failure of the defensive Bearer-only guard.

Missing credentials return:

```http
WWW-Authenticate: Bearer resource_metadata="https://wiki.example.com/.well-known/oauth-protected-resource", scope="pages:read"
```

Invalid credentials return:

```http
WWW-Authenticate: Bearer error="invalid_token", error_description="The access token is invalid or no longer usable.", resource_metadata="https://wiki.example.com/.well-known/oauth-protected-resource", scope="pages:read"
```

The middleware does not alter other API routes. Infrastructure failures remain
`500`; they are not misreported as credential failures.

### §4.4 Authorization Server Metadata

RFC 8414 metadata retains `CLIENT_URL` as `issuer` and adds
`registration_endpoint` while the master switch permits external onboarding
and DCR mode is not disabled. A cached direct call still passes runtime
policy.

The metadata continues to advertise:

- authorization code and refresh token grants;
- S256;
- `token_endpoint_auth_methods_supported: ["none"]`; and
- existing seeded-client capabilities.

It does not advertise `client_id_metadata_document_supported` in the first
implementation.

## §5 Public Dynamic Client Registration

### §5.1 Registration contract

The authorization server adds a public, prefix-independent OAuth registration
route implementing the RFC 7591 subset needed by MCP clients:

```ts
type DynamicClientRegistrationRequest = {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: 'none';
  grant_types?: Array<'authorization_code' | 'refresh_token'>;
  response_types?: Array<'code'>;
  scope?: string;
};
```

The response contains an opaque generated `client_id`, issue time, normalized
public-client capabilities, exact redirect URIs, and the accepted scope
maximum. It contains no client secret, registration access token, or
client-management URI.

Generated DCR ids use at least 256 bits of randomness. This generation rule is
local to DCR. It is not a validation rule applied to inbound `client_id`
values elsewhere.

### §5.2 Validation

Every dynamic client is forced to:

- `type: "public"`;
- `secretHash: null`;
- `token_endpoint_auth_method: "none"`;
- authorization-code and refresh-token grants only;
- response type `code` only;
- S256 PKCE for every authorization;
- `firstParty: false`;
- `trusted: false`; and
- the canonical MCP resource only.

Dynamic redirect URIs:

- are required and limited to five;
- must be absolute HTTPS URLs;
- may not contain credentials or fragments;
- are stored after URL validation; and
- are compared by exact string equality during authorization.

The request body is limited to 16 KiB, names to 128 Unicode code points, and
individual redirect URIs to 2,048 bytes. These are DCR payload limits. The
resolver and the shared authorize/token schemas do not impose a
storage-derived length, character-class, opaque-id, or URL-format rule on
`client_id`.

Requested scopes are a maximum, not a grant. The effective maximum is the
requested subset intersected with administrator policy. Omission defaults to
`pages:read`. Existing records do not silently gain `pages:write` when an
administrator later loosens global policy; expansion requires explicit client
approval or re-registration.

Dynamic clients cannot use the device authorization grant. Seeded clients keep
their explicitly backfilled grant capabilities: `grantTypes` is
`Array<'authorization_code' | 'refresh_token' | 'urn:ietf:params:oauth:grant-type:device_code'>`;
the device-code value is present only for seeded rows that currently support
it. Authorization-server discovery continues to advertise device authorization
only while at least one applicable seeded client flow remains supported; DCR
metadata and validation never advertise or accept it for dynamic clients.

### §5.3 Activation modes

The administrator selects exactly one DCR mode:

| Mode | Registration result | Authorization behavior |
|---|---|---|
| `automatic` | Create `status: active`. | The client can proceed immediately, but user consent remains mandatory. |
| `approval_required` | Create `status: pending`. | Crowi shows a local pending page and issues no code until an administrator approves. |
| `disabled` | Do not advertise registration and reject direct DCR. | Existing active clients continue unless revoked or the master switch is off. |

The master switch defaults off. DCR mode defaults to `approval_required` when
external OAuth is first enabled. Operators may intentionally select
`automatic`; this is not hard-coded as universally safe or universally
forbidden.

Turning off the master switch rejects new registration, authorization, token
exchange, refresh, and MCP access for dynamic clients. It does not affect PATs
or seeded clients.

### §5.4 Abuse controls and bounded capacity

Public DCR is unauthenticated and therefore has dedicated controls:

- strict body and metadata validation;
- per-source and global rate limits;
- a configurable stored-client quota;
- cleanup of unused registrations;
- structured audit events;
- administrator inventory and revocation; and
- a dedicated, shared, fail-closed DCR limiter.

Source addresses come only from a configured trusted-proxy chain or the socket
peer. Stored correlation uses a keyed hash, not the raw address. The DCR
limiter is a separate Redis-backed implementation (or a new explicit
`failureMode: 'closed'` mode that is used only by this endpoint), with keys
including the source hash and a global key. Crowi's existing fail-open,
per-process limiter is not reused. External DCR cannot be enabled unless this
shared limiter is healthy; loss of it rejects only new DCR with
`temporarily_unavailable`, never changes the posture of MCP, autocomplete, or
attachment limiters.

The cross-replica client quota uses one bounded Mongo admission document.
Registration atomically reserves a generated client id only if the reservation
count is below the configured maximum. Client creation uses that id
idempotently. A failed or crashed creation leaves a dated reservation that a
reconciler can release after proving no matching client exists. Revoke and
unused-client cleanup release reservations idempotently.

Quota exhaustion rejects registration with `temporarily_unavailable`. It does
not perform a cross-document “transactional eviction.” Cleanup may later free
space, but admission never depends on a MongoDB transaction.

The quota has both a global stored-client cap and a per-source stored-client
cap. Before rejecting a new registration, admission may atomically reclaim
only the oldest never-authorized `pending` or unused `active` registration
that is beyond its configured short pending/unused lifetime; it never evicts a
client with a grant. Pending registrations have a shorter default retention
than active unused registrations and are bulk-removable by source/status in
the administrator UI. This bounds unattended approval queues and prevents a
small set of unauthenticated sources from holding the feature capacity for the
full seven-day unused lifetime.

### §5.5 One client-resolution boundary

All OAuth paths use:

```ts
type ResolvedOAuthClient = {
  clientId: string;
  name: string;
  type: 'public' | 'confidential';
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[];
  firstParty: boolean;
  trusted: boolean;
  source: 'seeded' | 'dynamic' | 'metadata_url';
  status: 'pending' | 'active' | 'revoked';
  policyVersion: number;
  protocolVersion: number;
};

type OAuthClientResolution =
  | { ok: true; client: ResolvedOAuthClient }
  | {
      ok: false;
      reason: 'invalid' | 'disabled' | 'temporarily_unavailable';
    };

resolveOAuthClient(clientId: string): Promise<OAuthClientResolution>
```

The first implementation returns seeded and DCR-backed clients only.
`metadata_url` reserves the normalized source for future CIMD and is not
reachable or advertised yet.

No caller:

- queries `OAuthClient` directly;
- validates `client_id` by length, character class, prefix, or URL shape;
- assumes a database miss is the only resolution failure;
- says “not registered” in a protocol error; or
- persists a `ResolvedOAuthClient` as though it were a Mongoose document.

This is required because a future CIMD id is the metadata URL itself. A
DB-first rule such as “look up the string and reject when missing” is
incompatible with that client-id form.

The public `GET /oauth/client-info` route is removed. A replacement
authorization-context endpoint calls this resolver and, only after
validating the complete authorize request server-side, returns a short-lived,
signed context id containing client status/source, exact validated redirect
URI and origin, resource, requested/effective scopes, and consent mode. It
does not reveal a client name or existence for an arbitrary `client_id`; a
pending, revoked, disabled, or unresolved client receives the same neutral
authorize-context result. The web page submits only this context id, never
raw authorize query values, to complete or deny consent.

The OAuth wire error remains the standard `invalid_client`, with neutral text
such as “The client could not be resolved or is not eligible for this
request.” Transient resolver failure may map to `temporarily_unavailable`;
neither response assumes missing registration.

## §6 Resource, issuer, and audience binding

### §6.1 Authorization request

`resource` becomes optional in shared schemas for seeded-client compatibility
but mandatory for every dynamic client. It must equal the canonical MCP
resource exactly after trusted normalization.

The authorization page preserves `resource` through:

1. client/context validation;
2. consent display;
3. authenticated authorization submission; and
4. the authorization-code record.

The server rejects an external request with missing, multiple, unknown, or
fragment-bearing resources, or a different origin, port, path, or
trailing-slash identity.

### §6.2 Token exchange and refresh

Authorization-code exchange repeats the same `resource`. Mismatch or omission
for a dynamic client returns `invalid_grant`.

Refresh records add `resource`, `grantId`, lifecycle state, and operation
coordinator fields. Refresh repeats the resource, cannot change the grant, and
may only downscope. Refresh never adds `pages:write`; write requires a new
authorization code after explicit consent.

Seeded clients that omit `resource` keep their existing general-API behavior,
but unbound OAuth tokens are never accepted at MCP. PATs remain a separate
credential type and do not acquire an OAuth audience.

### §6.3 OAuth access JWT

Resource-bound OAuth tokens use normalized `CLIENT_URL` as issuer. Web-session
JWT verification remains a separate domain; this RFC does not change the web
session issuer merely to align MCP.

An MCP access JWT contains:

```ts
{
  type: 'oauth_access';
  userId: string;
  email: string;
  scope: 'pages:read' | 'pages:read pages:write';
  client_id: string;
  grant_id: string;
  aud: 'https://wiki.example.com/api/mcp';
  iss: 'https://wiki.example.com';
  exp: number;
}
```

The default MCP access lifetime is ten minutes. Expiry is defense in depth;
immediate revocation relies on durable client, grant, and policy checks.

### §6.4 Audience isolation

An MCP-audience token must not become a general REST token merely because MCP
reuses in-process Hono handlers
(`packages/api/src/mcp/dispatch.ts:1-24,80-119`).

The outer MCP boundary verifies once and builds a private resolved-auth
context. `makeDispatch` is changed to construct the `Request` itself and adds
that object to a module-private `WeakMap<Request, ResolvedMcpAuth>` before
calling `honoApp.fetch(request)`. A first middleware in the dispatched router,
ordered before `createJwtAuth` and `requireScope`, consumes and deletes that
WeakMap entry, installs the resolved user/scopes in Hono context, and rejects
any request without it. The map, key type, and consuming middleware are not
exported; no header, URL, body field, symbol, or process-global identifier is
accepted as a substitute. The public HTTP router never mounts this middleware
and continues to reject the MCP audience. Tests exercise a real dispatched
request, direct public requests, and forged serializable markers.

## §7 MCP credential boundary

MCP accepts only an explicit `Authorization: Bearer ...` credential of one of
these forms:

- a valid Crowi PAT; or
- a valid `type: "oauth_access"` token bound to the canonical MCP resource.

MCP does not accept:

- access-token cookies;
- refresh-token cookies;
- ambient browser session state; or
- a normal web-session `type: "access"` JWT, even when supplied in the
  Authorization header.

The current shared middleware accepts both web-session and OAuth Bearer JWTs
and can fall back to a cookie
(`packages/api/src/hono/middleware/auth.ts:67-85,127-149`). MCP therefore
requires a dedicated credential policy before that fallback. A malformed
Authorization header cannot fall through to a valid session cookie.

This explicit decision narrows the remote-resource boundary and prevents a web
session from receiving all scopes at MCP
(`packages/api/src/hono/middleware/auth.ts:139-147`).

## §8 Scope selection and write authorization

### §8.1 Scope mapping

| Tools | Required scope |
|---|---|
| Page reads, lists, history, backlinks, autocomplete, and search | `pages:read` |
| Create, update, rename, delete, restore, and revert | `pages:write` |

The existing descriptors already record these scopes
(`packages/api/src/mcp/tools/page.ts:177-315`,
`packages/api/src/mcp/tools/search.ts:41-52`). The same descriptor becomes the
single source for advertised OAuth metadata, annotations, and expected
downstream route scope.

### §8.2 Authorization scope selection

The authorization request selects the complete authority the connector will
use: `pages:read` or `pages:read pages:write`. The documented, interoperable
connector configuration requests read/write on its first authorization; an
operator that selects the read-only cap receives only `pages:read`. Crowi does
not claim that an MCP tool result, `_meta`, or a local page can deliver a
stronger token to a remote credential store. A later expanded grant is a new
normal OAuth authorization only when the client independently supports
starting it; it is not a required connector feature in this RFC.

Consent identifies:

- the external client name and dynamic-client badge;
- the exact redirect origin;
- the Crowi MCP resource;
- that wiki content may be sent to an external AI service; and
- the exact requested read and, where present, write authority.

Dynamic clients never skip consent.

### §8.3 Tool security metadata on SDK 1.29.0

The current lock resolves `@modelcontextprotocol/sdk` to `1.29.0`
(`pnpm-lock.yaml:12-14,274-276`). Its `registerTool` config supports
`annotations` and `_meta` but has no top-level `securitySchemes`; Crowi's
current registration passes only description and input schema
(`packages/api/src/mcp/server.ts:151-158`). Treating top-level
`securitySchemes` as though the installed SDK preserved it would silently
advertise no tool policy.

The first implementation therefore uses an explicit compatibility extension:

- each tool descriptor owns
  `securitySchemes: [{ type: "oauth2", scopes: [...] }]`;
- the registration adapter copies the exact array into
  `_meta["securitySchemes"]`, a field that SDK 1.29.0 preserves through its
  supported `_meta` object;
- the adapter emits annotations from the same descriptor; and
- a wire-level `tools/list` test, not only a TypeScript object test, asserts
  that ChatGPT receives the security-scheme mirror for every tool.

This is the documented compatibility metadata surface for clients that read
security schemes from `_meta`. Crowi does not cast an unsupported top-level
field into the SDK config and assume success. When the SDK is upgraded to a
version that natively serializes top-level `securitySchemes`, the adapter emits
both the standard field and the `_meta` mirror from the same array until
compatibility data shows the mirror can be removed.

### §8.4 Insufficient scope

MCP dispatch intentionally converts downstream route responses into MCP tool
results. It therefore cannot use a downstream `403` or a tool `_meta` field as
an OAuth transport: SDK 1.29.0 starts upscoping only from an outer HTTP `403`
and its `WWW-Authenticate` header, and Crowi has no Streamable-HTTP-compliant
outer-403/retry protocol. A missing scope is returned as the normal sanitized
MCP `isError` tool result, with no `mcp/www_authenticate` field and no promise
of automatic reauthorization. PAT callers receive the same ordinary missing-
scope result; they are never instructed to perform OAuth.

If a future documented ChatGPT contract proves a tool-level OAuth escalation
and token-delivery path, it is a separate RFC and must include exact wire
tests against that client. It is not an assumed extension of SDK 1.29.0.

### §8.5 Read-only administrator cap

When maximum external scope becomes read-only:

- Protected Resource Metadata stops advertising `pages:write`;
- new write authorization returns `invalid_scope`;
- refresh cannot add write and an existing write grant is fenced;
- an existing dynamic write token fails the current policy check; and
- read-only tokens and grants continue to work.

A write tool returns a policy-denied result without an OAuth challenge.

## §9 Data model and standalone-MongoDB protocol

### §9.1 OAuthClient additions

Stored clients add:

```ts
registrationSource: 'seeded' | 'dynamic';
status: 'pending' | 'active' | 'revoked';
grantTypes: Array<'authorization_code' | 'refresh_token' | 'urn:ietf:params:oauth:grant-type:device_code'>;
requestedScopes: string[];
effectiveMaxScopes: string[];
createdByIpHash: string | null;
approvedAt: Date | null;
approvedBy: ObjectId | null;
lastAuthorizedAt: Date | null;
lastUsedAt: Date | null;
revokedAt: Date | null;
revokedBy: ObjectId | null;
```

Seeded rows are idempotently backfilled as active, with their current
authorization-code/refresh/device capabilities, and are not governed by the
external-client master switch. Dynamic rows can never become seeded,
first-party, trusted, or confidential.

`requestedScopes` is the immutable registration request; `effectiveMaxScopes`
is the administrator-approved subset. A policy loosening never changes the
latter. The administrator inventory action **approve scope expansion** selects
a subset of `requestedScopes`, CASes `effectiveMaxScopes` and policy version,
and audits the actor. A dynamic client may instead re-register. This is the
only way an already read-only effective maximum can later permit write.

### §9.2 OAuthGrant

A grant represents one user's authorization of one resolved client for one
resource:

```ts
type OAuthGrant = {
  _id: ObjectId;
  userId: ObjectId;
  clientId: string;
  resource: string | null;
  scopes: string[];
  status: 'active' | 'revoked';
  version: number;
  activeKey: string;
  lastAppliedOperationId: string | null;
  createdAt: Date;
  lastAuthorizedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: ObjectId | null;
};
```

At most one grant is active for `{ userId, clientId, resource }`. A plain
unique `activeKey` is
`active:<sha256(userId + clientId + resource)>` while active and changes to
`revoked:<grantId>` on revocation. This permits historical rows without a
partial-index dependency.

Dynamic MCP grants always have the canonical resource. Seeded general-API and
device grants use `resource: null` and a distinct `activeKey` namespace. They
remain on the legacy seeded exchange/refresh path and are never accepted by
MCP; only dynamic resource-bound authorization-code exchanges enter the MCP
issuance coordinator below.

### §9.3 Why transactions are not a prerequisite

Crowi's default `docker-compose.yml` runs `mongo:8` without replica-set
initialization (`docker-compose.yml:23-31`). RFC-0019 and RFC-0021 both treat
standalone MongoDB as supported. External MCP OAuth must therefore work in
that standard configuration.

The correctness rules are:

- one document owns each irreversible state transition;
- every cross-document effect has a deterministic operation id and target id;
- the owner stores a bounded outbox/coordinator state;
- target writes are idempotent;
- access JWTs are signed only after durable materialization and a final
  authoritative-state reread;
- repair resumes incomplete operations; and
- revocation documents are request-time fences, so asynchronous cleanup is
  not an authorization dependency.

Multi-document transactions may be used as an optional optimization on a
replica set, but observable behavior and correctness cannot depend on them.

### §9.4 Authorization-code exchange coordinator

The authorization code remains the first-use boundary, but it is not the
durable coordinator: its existing unconditional TTL index can delete it.
An `OAuthIssuanceOperation` collection owns recovery and has an explicit
terminal-state TTL index; the code stores only `issuanceOperationId` after it
is consumed. Its bounded record contains:

```ts
type OAuthIssuanceOperation = {
  operationId: string;
  state:
    | 'reserved'
    | 'grant_applied'
    | 'refresh_created'
    | 'refresh_activated'
    | 'committed'
    | 'aborted';
  grantId: ObjectId;
  expectedGrantVersion: number | null;
  refreshId: ObjectId;
  codeId: ObjectId;
  reservedAt: Date;
  terminalAt: Date | null;
};
```

Exchange proceeds:

1. Atomically consume the code first, exactly as the current `consume()` does,
   before client, redirect, PKCE, resource, or scope diagnostics. Any exchange
   attempt burns the code; a second attempt returns `invalid_grant`.
2. Validate the consumed code and request, then generate operation, grant,
   refresh, and opaque refresh-token values in memory. Validation failure
   creates an aborted operation and returns `invalid_grant`.
3. Insert the durable operation with deterministic target ids, then CAS the
   consumed code to reference it. A duplicate/loser returns `invalid_grant`.
4. Create or update the grant using `activeKey`, expected version, and
   `lastAppliedOperationId`. Repeating the same operation is a no-op. A normal
   later authorization may set only scopes within the client's effective
   maximum and current policy.
5. Create the refresh row in `pending` state with deterministic id,
   operation id, token hash, client, user, resource, grant id, and scopes.
6. Advance the durable operation after each materialized target.
7. CAS-activate the pending refresh first (`state: pending`, matching
   operation id), advance the operation to `refresh_activated`, and only then
   CAS it to `committed`. Repair always resumes `reserved`, `grant_applied`,
   `refresh_created`, and `refresh_activated`; committed is terminal only
   after active refresh is proven by id/state/operation id.
8. Reread the client, grant, and durable policy. Only if all remain eligible
   does Crowi sign the access JWT and return the in-memory refresh plaintext.

A crash can strand an operation, applied grant, or pending refresh row, but
cannot produce an access token before durable state exists. Repair resumes the
deterministic writes. Because only hashes are stored, a crash after consuming
the code but before returning the refresh plaintext may require a fresh
authorization; the RFC does not weaken token-at-rest protection to make that
rare response recoverable.

If policy or revocation changes before the final reread, the operation becomes
aborted, any pending refresh is revoked, and no access JWT is returned. An
already expanded grant is still fenced by the new policy and can be
downscoped/revoked by repair; temporary over-recording cannot authorize a
request because every use rechecks the current policy.

### §9.5 Refresh rotation coordinator

Every new resource-bound refresh row has an immutable random `familyId`, an
index on `{ familyId, state }`, and a bounded rotation coordinator. An initial
MCP grant creates one family; a new authorization (including a later normal
expanded authorization) creates a new family. The presented refresh-token
document owns rotation. Clients may send a cryptographically random
`Idempotency-Key` header; it is stored as the bounded rotation operation id
  and expires with the short retry window. One CAS changes it from `active` to
`rotating` and
embeds an operation id plus deterministic successor id/hash. Only the CAS
winner may create the successor.

For an idempotent refresh, the opaque successor value is derived from a
server-held rotation HMAC key and the operation id, then only its hash is
stored. During the short retry window the server can recompute and return the
same value without persisting refresh plaintext; after that window the receipt
is removed and a consumed-token presentation is treated as replay.

The winner:

1. validates client, grant, resource, requested downscope, and policy;
2. reserves rotation on the source document;
3. creates the successor as `pending`;
4. activates the successor idempotently, then CASes the source to `consumed`
   with `rotatedTo`;
5. rereads client, grant, and policy; and
6. signs a new access JWT and returns the successor plaintext only while all
   fences remain valid.

A repair worker completes or revokes stale `rotating` operations. A request
that finds `rotating` or `consumed` with the same `Idempotency-Key` operation
id replays that
operation's already-created successor result while it is within its short
retry window; a request without that receipt receives `invalid_grant` but does
not revoke the family merely for a concurrent loss. A later presentation of a
consumed token outside that receipt window is hostile reuse: one bounded
`updateMany({ familyId, state: { $in: ['active', 'rotating', 'pending'] } })`
revokes the family. Thus there is one usable successor, benign retries do not
kill it, and replay has bounded database work.

### §9.6 Revocation as an authoritative fence

Revoking one grant CASes that grant to `revoked` and changes its `activeKey`.
That single write blocks the next MCP request and refresh. Cleanup of related
refresh rows is an idempotent outbox effect and may complete later.

Revoking a client CASes the client to `revoked`. That one row blocks all its
authorization, exchange, refresh, and MCP use. Grant/refresh cleanup is again
asynchronous and idempotent.

The global master switch and maximum scope live in the existing typed `Config`
namespace through `ConfigService`, with a monotonically increasing policy
version. `ConfigService`/Redis invalidation is used for normal cached reads;
security-critical transitions also compare the durable version captured in
the grant/client at final issuance and MCP authorization. Cache-miss and
version-check behavior has a defined latency budget: one batched client/grant
lookup plus one cached policy read on MCP requests, and no more than two
additional writes/reads on token issuance. Redis is an optimization, never
the sole authority.

The ten-minute access-token lifetime limits exposure from an implementation
failure but is not the revocation mechanism. A JWT denylist is unnecessary.

### §9.7 Retention

Initial defaults:

- pending dynamic clients: delete after 24 hours; unused active dynamic
  clients: delete after 7 days;
- used revoked clients and grants: retain for 90 days;
- expired code and legacy refresh rows: retain existing TTL behavior; resource
  refresh rows retain a bounded family record for replay/retention and are
  swept after the configured retention period.

Cleanup never removes an active grant or an active client with an active
grant. Only `OAuthIssuanceOperation.terminalAt` is TTL-swept; the existing
authorization-code TTL is not a recovery dependency. Indexes include
`familyId/state`, `grantId/state`, operation id, active key, and expiry;
tests size a 30-day, ten-minute-access family and prove replay remains one
bounded update rather than a chain walk.

### §9.8 Migration and rolling activation

This RFC includes explicit migrations under the existing migration framework.
They backfill seeded `OAuthClient` source/status/grant types and, before the
feature is externally enabled, either backfill every live seeded refresh row
into the legacy path (`resource: null`, legacy state) or explicitly retain it
there until expiry. Existing `crowi-cli` and `crowi-ios` refresh tokens never
encounter the resource-bound `active → rotating` predicate. New dynamic/MCP
fields are additive first; indexes are built before code writes them.

Deployment is expand/backfill/activate, not “enable after local tests”:

1. deploy a compatibility release to every API replica. It understands old
   rows, rejects dynamic clients and MCP-bound OAuth tokens while the durable
   external-feature gate is disabled, and reports capability version `0022`.
2. run migrations/backfill and verify all live replicas report that capability
   and the policy/config schema version.
3. enable one globally durable external-feature gate. New code checks it at
   DCR, authorize, token, refresh, and MCP acceptance; compatibility code
   checks it before it can resolve/issue/accept a dynamic client token.
4. only then expose `registration_endpoint` and permit DCR.

Rollback turns the durable gate off before any older replica is introduced.
Interleaving tests run old-compatible and new handlers against the same Mongo
state and prove no replica can issue or accept an unbound dynamic-client token
before activation.

## §10 Administrator and user experience

### §10.1 AI integrations placement

Crowi's administrator navigation has Security and Authentication entries
followed by Plugins
(`packages/web/src/components/admin/admin-sidebar.tsx:47-76`). Add
**AI integrations** under Authentication and before Plugins.

Routes are prefix-independent:

- web: `/admin/ai-integrations`;
- admin API: `/admin/ai-integrations/*`, protected by
  `createJwtAdminRequired(crowi)`; and
- user: `/me/connected-apps`, with authenticated user-only grant APIs.

### §10.2 Settings

| Setting | Values | Default |
|---|---|---|
| Allow external MCP OAuth clients | on/off | off |
| DCR activation | automatic / approval required / disabled | approval required |
| Maximum external scope | read-only / allow initial read/write | read-only |
| Maximum stored dynamic clients | bounded integer | 100 |
| Registration rate per source/hour | bounded integer | 10 |
| Global registration rate/hour | bounded integer | 100 |
| Stored dynamic clients per source | bounded integer | 3 |
| Unused registration lifetime | 1–30 days | 7 days |
| Revoked record retention | 30–365 days | 90 days |

The page also shows resolved trusted URLs and the health of admission
dependencies. Setting changes validate the entire policy before durable
persistence.

### §10.3 Inventory and actions

Administrators can see:

- client name and complete client id;
- seeded/dynamic source;
- pending/active/revoked status;
- exact redirect origins and URIs;
- requested and effective maximum scopes;
- created, approved, last-authorized, last-used, and revoked times;
- active and historical connection counts; and
- connected users, their granted scopes, and last use.

Actions are approve, **approve scope expansion** (up to immutable requested
scopes), revoke, inspect grants, bulk-remove pending/unused registrations, and
remove an unused registration. There is no “make trusted,” “make first-party,”
“convert to confidential,” or client-secret action.

Names and redirect metadata are untrusted input and render as text only.

### §10.4 Connected apps

Users can list active and recently revoked external grants with client name,
dynamic badge, resource, scopes, authorization time, and last use. Revoking an
active grant applies the fence in §9.6. Reconnecting creates a new grant and
requires consent.

Connected apps does not offer write elevation. Write scope is deliverable only
through the external client's tool-level reauthorization flow.

### §10.5 Consent and redirect safety

The authorization UI has four states:

1. pending administrator approval;
2. read-only consent;
3. read/write consent; and
4. policy denied or revoked.

Every denial or error redirect uses the redirect URI retained in a
server-validated authorization context. The browser never constructs a target
from a raw inbound `redirect_uri`. The existing all-or-nothing consent card
remains appropriate because each authorization is a complete minimal grant
(`packages/web/src/app/(auth)/oauth/authorize/consent-card.tsx:26-30,48-66`).

Every `/oauth/authorize` GET, login/continue transition, and POST that renders
or accepts consent sends route-specific anti-framing headers:
`Content-Security-Policy: frame-ancestors 'none'` and
`X-Frame-Options: DENY`. These headers apply before authentication redirects,
not just on the final card, so a hostile DCR redirect cannot frame a victim's
approval click.

## §11 Component boundaries

### §11.1 API contract

`@crowi/api-contract` adds:

- Protected Resource Metadata schemas and routes;
- optional `resource` on authorize, code exchange, and refresh requests;
- conditional `registration_endpoint` in Authorization Server Metadata;
- public DCR request, response, and error schemas;
- authorization-context fields for external status, resource, redirect
  URI/origin, requested/effective scopes, and consent mode, plus the
  server-side context create/complete/deny routes;
- administrator policy/client/grant contracts; and
- user connected-app list/revoke contracts.

Every contract or route change regenerates OpenAPI artifacts with
`pnpm check:openapi`.

### §11.2 API server

The API owns:

- trusted issuer/resource/metadata URL builders;
- root and path-specific Protected Resource Metadata;
- MCP-specific challenge and credential middleware;
- `resolveOAuthClient`;
- DCR validation, admission, quota, status, and cleanup;
- code/refresh resource and grant binding;
- CAS/outbox issuance, refresh rotation, and repair;
- `OAuthGrant`;
- public-issuer OAuth JWT signing and verification;
- audience isolation for internal tool dispatch;
- client/grant/policy request-time fences;
- administrator/user lifecycle handlers; and
- tool security metadata and ordinary sanitized missing-scope tool errors.

Installed SDK helpers may be reused for standards-defined types,
serialization, or validation after Crowi wire tests cover their behavior.
They do not replace Crowi's models, consent, policy, resolver, or revocation.

### §11.3 Web

The web app owns:

- preserving `resource` through authorization;
- server-validated terminal redirect handling;
- read-only, read/write, pending, and denied consent states;
- external-client and redirect-origin disclosure;
- the AI integrations page and navigation;
- settings/client/grant queries and mutations; and
- Connected apps list and revoke.

Existing production proxy matching already includes `/.well-known/*`.
Development rewrites and tests must cover the new routes
(`packages/web/next.config.ts:136-189`, `Caddyfile:11-21`,
`scripts/dev-caddy.mjs:30-37`).

### §11.4 Operations documentation

Documentation covers:

- the canonical post-migration MCP URL;
- same-origin defaults and `MCP_PUBLIC_URL`;
- reverse-proxy routes for MCP and `/.well-known/*`;
- HTTPS;
- enabling external clients and choosing DCR mode;
- read-only default and initial read/write authorization;
- no tool-result OAuth step-up;
- client/user/global revocation; and
- a ChatGPT walkthrough beginning with only the MCP URL.

## §12 Security and failure handling

### §12.1 Unauthenticated DCR abuse

Public registration is deliberately unauthenticated. Its controls are policy
gates, bounded metadata, dedicated shared fail-closed source/global limits,
per-source and global stored quotas, pending-first expiry/reclamation, audit,
and revocation. Failures do not disclose existing metadata and never return a
reusable secret. `/oauth/token`, `/oauth/authorize`, and
`/oauth/device/authorize` receive their own endpoint-specific abuse limits;
they are not left unlimited because DCR is public.

### §12.2 Redirect and client impersonation

Dynamic redirects are HTTPS-only and exact-match. Crowi validates client,
status, redirect, resource, PKCE, and scope before any redirect can carry an
authorization code.

The consent route is not frameable, including login and continue states, so
an attacker cannot turn a validated dynamic redirect into a clickjacked
approval surface.

A DCR client name is not proof of vendor identity. Consent and approval show
the exact redirect origin and a dynamic-client badge. A future CIMD source may
provide a URL-based identity, but this release does not claim that DCR does.

### §12.3 Host-header and audience confusion

Trusted configuration supplies every public identifier. The resource is
checked at authorization, code exchange, refresh, JWT verification, and MCP.
The private dispatch context prevents an MCP-audience token from becoming a
general API token.

### §12.4 Least privilege and external content

The authorization request uses the smallest scope set the connector chooses;
the documented interoperable configuration requests read/write once, and an
administrator may enforce read-only. Page authorization remains user-relative,
and underlying API route scope checks remain authoritative.

RFC-0011 prompt-injection fencing and result sanitization continue to apply
(`docs/rfcs/0011-crowi-mcp.md:343-407`,
`packages/api/src/mcp/result.ts`). They do not replace OAuth access control.

### §12.5 Failure matrix

| Failure point | Durable outcome | Recovery |
|---|---|---|
| Before code consumption | No mutation | Client retries |
| After code consumption before durable operation | Code is single-use; no token | Fresh authorization |
| After durable operation reservation | Code single-use; no token | Repair or fresh authorization |
| After grant CAS | Grant records operation; no token yet | Idempotent issuance repair |
| After pending refresh create | Pending token is unusable | Coordinator repair activates or revokes |
| After refresh activation before operation commit | Active refresh plus resumable nonterminal operation | Repair proves activation then commits, or revokes on conflict |
| After commit before response | Durable grant/active refresh; response may be lost | Safe fresh authorization if plaintext was lost |
| Concurrent code exchange | One reservation winner | Loser gets `invalid_grant` |
| Concurrent refresh | One source-document CAS winner | Same idempotency key replays successor; a different concurrent loser gets `invalid_grant` without family revocation |
| Grant revoke during issuance | Grant fence wins at final reread or next request | No usable request after revoke |
| Client revoke before cleanup | Client row immediately blocks use | Async grant/refresh cleanup |
| Master switch off | Durable policy immediately blocks dynamic clients | No dependency on pub/sub |
| DCR limiter outage | New DCR fails closed | Existing authorized clients remain governed by Mongo |
| Code-document TTL | Code may expire/delete | Durable issuance operation remains resumable |
| Repair worker crash | Durable operation remains bounded and resumable | Another worker continues |

## §13 Verification requirements

### §13.1 Discovery and credential boundary

- Missing Authorization returns exact `resource_metadata` and read-scope
  challenge.
- Malformed, expired, revoked, wrong-issuer, wrong-audience, disabled-client,
  and revoked-grant credentials return `error="invalid_token"` plus
  `error_description`.
- Root and path-specific metadata return the same canonical values.
- Host and forwarded-host changes cannot affect discovery, issuer, endpoints,
  or JWT audience.
- Same-origin and split-origin fixtures produce correct resource and
  authorization-server origins.
- Connector CORS preflight/allow-list behavior works for public endpoints and
  exposes `WWW-Authenticate`; an unrelated origin is denied.
- A valid access cookie does not authenticate MCP.
- A malformed Authorization header plus valid session cookie still fails.
- A web-session Bearer JWT fails; PAT and MCP OAuth Bearer credentials pass.

### §13.2 Client resolution and DCR

- All OAuth paths use `resolveOAuthClient`; a static check rejects direct
  `OAuthClient` lookup outside the resolver/model boundary.
- Opaque and URL-form `client_id` values reach the resolver without a
  field-specific syntax or length rule derived from storage.
- Neutral `invalid_client` errors do not say “unregistered.”
- DCR creates only secretless public clients with opaque ids.
- Confidential methods, requested secrets, unsupported grants, unsafe
  redirects, oversized metadata, and unknown scopes fail.
- Automatic, approval-required, disabled, and master-off modes have distinct
  behavior.
- Rate limits fail closed as configured, and quota reservation remains correct
  under concurrent registration and crash repair.
- Dynamic clients cannot become trusted/first-party or use device grants.
- Public `client-info` cannot be used as an arbitrary client existence/name
  oracle; server-issued authorize contexts drive every consent state.

### §13.3 Resource and token lifecycle

- `resource` survives authorization query, consent, code, token exchange,
  refresh rotation, and JWT.
- Missing, unknown, or mismatched resources fail at every transition.
- MCP JWTs contain public issuer, exact audience, scope, client id, grant id,
  and ten-minute expiry.
- MCP rejects unbound and wrong-resource OAuth tokens.
- Public REST rejects an MCP-audience token while marked in-process dispatch
  succeeds.
- Refresh cannot add scope or change resource/grant.
- Seeded authorization-code/device refresh flows remain on their explicit
  legacy path and their regression suites remain green.
- Direct REST cannot forge dispatch context; a real WeakMap-marked in-process
  request succeeds before JWT/scope middleware.

### §13.4 Standalone MongoDB concurrency and repair

- Tests run against standalone MongoDB without transaction support.
- Failed code validation burns the code; two exchanges yield one consumed-code
  winner and no partial usable token.
- Initial grant creation and subsequent normal authorization are idempotent by
  operation id.
- Every crash point in §12.5 is injected and repaired.
- Crash injection between refresh activation and operation commit repairs to a
  terminal active/committed state or revokes deterministically.
- Two refreshes with the same idempotency key yield one successor and the same
  wire result; a different concurrent loser gets `invalid_grant` without
  revoking it; hostile replay revokes the indexed family with one `updateMany`.
- A long-lived ten-minute-access family has bounded replay query work and the
  declared indexes/retention.
- Grant/client/master revocation racing issuance cannot produce a request that
  passes the next durable fence.
- No test conditionally skips correctness when sessions/transactions are
  unavailable.

### §13.5 Read/write story and SDK wire surface

- Read-only and read/write authorization requests display and issue exactly
  their requested permitted scopes.
- Read/search tools succeed.
- Every write tool advertises OAuth `pages:write`; every read tool advertises
  `pages:read`.
- SDK 1.29.0 `tools/list` output contains the exact
  `_meta["securitySchemes"]` compatibility mirror.
- Tool annotations match actual read/write/destructive behavior.
- Read-token write calls return an ordinary `isError` without an OAuth
  challenge or `mcp/www_authenticate`; PAT callers receive the same treatment.
- A standard initial read/write authorization yields a token that can perform
  writes. No test claims SDK 1.29.0 can consume a tool-level step-up signal.
- Read-only administrator policy returns a non-reauthorizing policy error.

### §13.6 Revocation, UI, and end-to-end

- User grant revoke blocks access and refresh at the next request.
- Administrator client revoke blocks all connected users.
- Master-off blocks dynamic clients without changing PAT or seeded behavior.
- Administrator inventory shows connected users and lifecycle state.
- Connected apps lists and revokes grants but does not offer unreachable write
  elevation.
- Error and deny paths navigate only to server-validated redirect URIs.
- A cross-origin frame of every authorize/login/continue/consent route is
  denied by CSP frame-ancestors and X-Frame-Options.
- Automated end-to-end coverage performs discovery, DCR, PKCE authorization,
  resource-bound exchange, MCP initialize/list/read/write, refresh,
  and all revocation levels.
- Live verification covers ChatGPT and one other standards-compliant MCP
  client.
- API changes run `pnpm check:openapi`; all phases run targeted tests,
  type-check, lint, and build gates.

## §14 Alternatives considered

### §14.1 Standards-complete OAuth with public DCR first — selected

This is the design in this RFC. It fits the existing DB-backed client lifecycle
after accounting for a complete custom DCR subsystem: cryptographic ids,
public-only validation, a dedicated fail-closed shared limiter, source/global
quotas, pending-first cleanup, approval, and request-time policy fences. The
installed `@hono/mcp` DCR code is types/wire-shape reference only, not a
hardened handler to reuse. The centralized resolver prevents the first
implementation from becoming a permanent DB-only architecture.

The trade-off is a cross-cutting API, model, JWT, MCP, web, and administrator
change. That scope reflects the actual authorization boundary.

### §14.2 CIMD-only — rejected for the first implementation

CIMD-only is a legitimate and standards-favored alternative. The MCP
specification says authorization servers SHOULD support it, compared with MAY
for DCR. It avoids a public registration endpoint and does not create an
anonymous `OAuthClient` for each attempted connection. A URL `client_id` can
also provide a more meaningful client identity boundary than an unverified DCR
display name.

It is not selected now for implementation-specific reasons:

1. Crowi's locked dependency surface provides useful standards types and wire
   shapes, but no hardened DCR handler or server-side CIMD resolver. Its DCR
   handler cannot satisfy Crowi's 256-bit id, cryptographic secret, public-only
   admission, or source-aware limiter requirements.
2. A safe CIMD resolver needs SSRF prevention, DNS pinning, single-flight,
   negative caching, per-host concurrency limits, bounded fetches, and
   fail-closed behavior. DCR also needs controls, so the decision is not based
   on pretending either option is mechanism-free.
3. Crowi already has a DB lifecycle for DCR. CIMD still needs durable shadow
   records for local approval, revocation, scope caps, audit, and connection
   visibility.

This rejection is about today's complete-system cost, not standards
superiority. Before implementation, the team must write down the DCR and CIMD
costed threat-model checklists and re-evaluate this choice; neither side may
claim an installed helper as its implementation credit. A supported hardened
CIMD resolver may change that result, but only if it also meets Crowi's local
policy/lifecycle requirements.

### §14.3 DCR and CIMD together — rejected

Shipping both maximizes compatibility but combines unauthenticated
registration controls with outbound-fetch security and two lifecycle sources
in the first release. The resolver seam preserves the option without doubling
the initial security-critical surface.

### §14.4 Administrator manual preregistration — rejected

Manual preregistration avoids public registration but does not fit the generic
URL-only connector flow. Crowi has no client-registration UI, and no standard
client-secret copy step is available in that flow.

### §14.5 Protected-resource metadata and challenge only — rejected

Discovery would proceed to a client and resource-bound token flow Crowi cannot
complete. A small diff would provide no end-to-end connector value.

### §14.6 Legacy `/sse` transport — rejected

Crowi already uses stateless Streamable HTTP on `/mcp`
(`packages/api/src/mcp/attach.ts:16-20,101-119`;
`docs/rfcs/0011-crowi-mcp.md:169-178`). A legacy `/sse` endpoint does not solve
OAuth and would add deprecated surface and tests.

### §14.7 Initial read/write chooser — selected interoperable fallback

The first release uses the normal OAuth scope chooser because it is the only
proven end-to-end transport to deliver a token with writes to a remote MCP
client. Documentation defaults compatible connectors to the complete
read/write scope set, while an administrator can enforce read-only. This
requests more authority up front than a hypothetical tool-level step-up, but
it is honest, standards-compatible, and testable with SDK 1.29.0.

### §14.8 User-initiated local write elevation — rejected

Crowi could update a local grant and show a success page, but it cannot place
the resulting access and refresh tokens into an unrelated external client's
credential store. Refresh is also prohibited from adding scope. Without a
defined delivery protocol this is not a fallback; it is misleading UI.

### §14.9 Request-host resource derivation — rejected

It appears convenient for reverse proxies but lets attacker-controlled input
affect discovery and audience. `MCP_PUBLIC_URL` supports split origins through
trusted configuration.

### §14.10 Multi-document transactions — rejected as a requirement

Transactions could simplify code/grant/refresh updates on replica sets, but
Crowi's standard MongoDB is standalone. Requiring them would disable the
feature in the default supported topology. CAS, bounded coordinators,
idempotency, and repair provide the normative protocol.

### §14.11 Short JWT lifetime without status checks — rejected

Expiry bounds exposure but does not make revocation immediate. Durable
client/grant/policy checks provide the fence; short lifetime is defense in
depth.

### §14.12 JWT denylist — rejected

A denylist adds per-token state and cleanup while client and grant state are
already needed for lifecycle and inventory. Checking those records revokes a
whole relationship at once.

## §15 Phased implementation plan

The master switch remains off throughout development. No partial phase is
advertised as external connector support.

### §15.0 Prerequisites and dependency audit

- Land the `/api/v2` to `/api` migration first.
- Verify the current dependency lock and inspect the then-current supported MCP
  SDK.
- Cost DCR and CIMD as complete hardened subsystems; installed DCR code is
  types/wire-shape reference only. Specifically determine whether the SDK
  provides a production-ready server-side CIMD resolver; if it does,
  re-evaluate §14.2 before implementation.
- Verify the tool descriptor wire surface. Keep the explicit
  `_meta["securitySchemes"]` adapter on SDK 1.29.0; adopt native top-level
  support only after an exact-version wire test proves it.

### §15.1 Trusted URLs, metadata, and credential boundary

- Add trusted issuer/resource/metadata builders.
- Add public-route connector CORS and endpoint-specific abuse limits.
- Add root and path-specific Protected Resource Metadata.
- Add MCP-specific `401` challenge and exact tests.
- Add explicit PAT/OAuth-only MCP authentication and reject cookie/web-session
  Bearer credentials.
- Do not enable discovery until resource/audience enforcement exists.

### §15.2 Resolver, DCR, and administrator policy

- Introduce `resolveOAuthClient` and migrate every OAuth lookup.
- Add source/status fields and seeded-client backfill.
- Add resource-refresh migration/legacy path, issuance-operation collection,
  family indexes, and expand/backfill activation protocol.
- Add public DCR validation, activation modes, admission, quota, cleanup, and
  audit.
- Add typed `ConfigService` AI integration policy and administrator contracts.
- Add AI integrations settings, inventory, approval, revoke, and connection
  visibility.

### §15.3 Resource-bound OAuth and standalone lifecycle

- Add `resource` contract fields and preserve them through the web authorize
  flow.
- Add `OAuthGrant` and resource/grant fields to codes and refresh rows.
- Split OAuth issuer verification from web-session verification.
- Add audience isolation and private in-process dispatch context.
- Implement code issuance and refresh rotation coordinators, repair workers,
  and crash/concurrency tests on standalone MongoDB.
- Add request-time client/grant/policy fences.

### §15.4 Consent and interoperable write authorization

- Enforce exact selected scope consent and policy cap.
- Add external-client consent copy.
- Derive annotations and security schemes from tool descriptors.
- Emit the `_meta["securitySchemes"]` compatibility mirror and pin wire tests.
- Return ordinary sanitized missing-scope tool errors; do not emit unsupported
  tool-level OAuth challenges.
- Add route-specific authorize anti-framing headers and complete
  authorization-context routes.
- Add Connected apps list and revoke only.

### §15.5 Interoperability and operations

- Run the complete automated story.
- Verify with live ChatGPT and another standards-compliant MCP client using
  the initial read/write flow.
- Document same/split origin, DCR modes, read-only caps, initial read/write
  selection, and
  revocation.
- Enable the feature only after OpenAPI, security, type, lint, test, and build
  gates pass.

## §16 Resolved decisions and open questions

### §16.1 Resolved decisions

1. The first implementation is public DCR, not CIMD.
2. Current MCP standards favor CIMD; DCR is selected only for present
   implementation cost and model fit.
3. All client lookup goes through a CIMD-ready resolver that does not assume an
   opaque or DB-registered `client_id`.
4. Initial authorization selects read-only or read/write; the interoperable
   default is initial read/write, not tool-level OAuth step-up.
5. SDK 1.29.0 uses an explicit `_meta["securitySchemes"]` compatibility
   extension with wire tests.
6. Tool results do not carry an unsupported OAuth upscoping channel.
7. There is no undeliverable local write-elevation fallback.
8. MCP accepts explicit PAT or MCP OAuth Bearer credentials only; cookies and
   web-session Bearer JWTs are rejected.
9. `MCP_PUBLIC_URL` supports split-origin deployment; request Host is never a
   trust source.
10. DCR activation is administrator-selectable:
    automatic, approval-required, or disabled.
11. The public API prefix migration lands before implementation.
12. Standalone MongoDB is supported through CAS/outbox/repair; transactions are
    not required.
13. Streamable HTTP remains the only MCP transport in scope.
14. Dynamic client/token acceptance is enabled only after all replicas report
    capability `0022` and the durable external-feature gate is set.

### §16.2 Residual open questions

No unresolved architecture question blocks implementation. Two implementation
gates intentionally depend on then-current external software:

1. whether the supported MCP SDK at implementation start has gained a
   production-ready server-side CIMD resolver sufficient to revisit the
   DCR-first decision; and
2. whether an exact supported SDK version natively preserves top-level tool
   `securitySchemes`, allowing Crowi to emit both that field and the
   compatibility mirror without a custom adapter.

Both gates have explicit fallback behavior in §15.0 and must be recorded in
the implementation plan rather than silently assumed.

## §17 References

- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750)
- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://www.rfc-editor.org/rfc/rfc7591)
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [OpenAI authentication guide for MCP servers](https://developers.openai.com/plugins/build/auth)
- [OpenAI plugin reference](https://developers.openai.com/plugins/reference)
- [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
