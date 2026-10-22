# RFC-0022: OAuth integration for external MCP connectors

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-07-29
- **Depends on**: RFC-0006 (Hono Integration), RFC-0010 (OAuth 2.0 Foundation & Scoped API Access), and RFC-0011 (Crowi MCP Server).
- **Implementation prerequisite**: the refresh-token family feature (immutable per-sign-in family ids, durable family revocation records, and a boot migration that revokes legacy family-less refresh tokens).
- **Satisfied foundations**: the `/api/v2` → `/api` migration, the PAT-only MCP credential boundary, and RBAC are on main.
- **Sequencing dependency**: `feature-rbac-cli-permissions-cli-mcp` assumes MCP is PAT-only; coordinate its integration and authentication tests with §15.1, which adds audience-bound OAuth access.
- **Related**: RFC-0012 (Crowi CLI) for seeded first-party clients and RFC-0019 (TOTP Two-Factor Authentication) for standalone MongoDB support.

## §0 Summary

Crowi lets standards-compliant remote MCP clients connect using only its public MCP URL and OAuth. ChatGPT and Claude.ai are the first interoperability targets. Discovery uses Protected Resource Metadata (PRM, RFC 9728) and Authorization Server (AS) Metadata (RFC 8414); external clients identify themselves with an HTTPS Client ID Metadata Document (CIMD) URL on an administrator-allowed host; authorization uses a code and S256 PKCE; RFC 8707 `resource` binds the resulting access token to the MCP audience.

MCP accepts explicit Bearer PATs or OAuth access tokens with the exact MCP audience. Cookies, web-session Bearer JWTs, and unbound OAuth access tokens are rejected. Public REST rejects every OAuth access token that carries an audience. Effective access is the intersection of the user's RBAC decision, token scope, and applicable administrator cap.

The external-client master switch defaults off and the client-host allowlist starts empty. Administrators manage allowed hosts, client approval (including adding and approving a client by URL), a scope cap that defaults to read/write, inventory, and revocation. Approval snapshots the client's name and redirect URIs; a changed redirect set returns the client to pending. Users see and revoke their connected clients. Initial authorization offers read-only or read/write, with read/write as the default when permitted; missing tool scope returns an ordinary tool error without automatic step-up.

One `resolveOAuthClient` boundary resolves CIMD clients and seeded first-party clients. Crowi fetches a CIMD document only after the user authenticates at the authorization endpoint, or when an administrator adds a client by URL; code exchange, refresh, and MCP use the durable client record and current policy, so a vendor metadata outage does not break connected sessions. The prerequisite refresh-token family and its revocation record represent each user connection. A second use of an authorization code revokes the family issued from it. A crash that loses a code exchange or token response requires reconnecting. Standalone MongoDB remains supported, and deployments stop all old replicas before starting the new build.

Crowi stays on SDK v1 and MCP protocol 2025-11-25 for this RFC. It adopts the current authorization recommendations without claiming implementation of the distinct 2026-07-28 MCP transport and lifecycle.

## §1 Background and motivation

### §1.1 Current implementation

Crowi already provides authorization-code OAuth with S256 PKCE, scoped access JWTs, refresh-token rotation with per-sign-in families and durable family revocation, consent, AS Metadata, and boot-seeded `OAuthClient` records. MCP exposes tools through `@hono/mcp` Streamable HTTP and dispatches to Hono routes that enforce token scopes and RBAC.

`packages/api/src/mcp/auth.ts` already installs `createMcpAuth`, a dedicated Bearer-only, PAT-only boundary using `resolveCredential` with cookie fallback disabled. It rejects web-session Bearer JWTs and cookies. It also rejects `oauth_access` JWTs because `packages/api/src/util/jwt.ts` currently signs them without a protected-resource audience. `verifyToken` checks only the issuer, and `jsonwebtoken` ignores `aud` unless an audience option is passed, so an audience claim alone would not keep a token out of REST. This RFC extends the MCP boundary only after audience binding and explicit REST audience rejection exist.

`packages/api/src/mcp/dispatch.ts` forwards the MCP caller's `Authorization` header verbatim into in-process route dispatch. With audience-bound tokens that forwarding would present an MCP-audience credential to REST authentication, so §6.4 replaces it with a private resolved-auth context.

The remaining work is resource-aware OAuth issuance and validation, PRM and challenges, CIMD resolution and policy, and external-client consent and administration. Authorization requests, codes, refresh rows, and the web consent flow must retain `resource`. The public API already uses `/api`; it is not a pending migration or a second audience.

### §1.2 Standards and client expectations

The MCP authorization specification dated 2026-07-28 requires PRM, resource indicators at authorization and token exchange, audience validation, no token passthrough, S256 PKCE, and refresh-token rotation for public clients. Clients refuse an authorization server that does not advertise `code_challenge_methods_supported`. A Bearer challenge should include `resource_metadata` and scope guidance. RFC 9207 authorization-response issuer identification is currently SHOULD and is expected to become MUST. Protocol 2025-11-25 says the authorization server SHOULD accept resource URIs whose scheme and host differ only in case.

The same revision recommends CIMD for clients and authorization servers. Dynamic Client Registration (DCR, RFC 7591) is deprecated and retained as an optional backward-compatibility mechanism. Client preference is pre-registered credentials, then CIMD when advertised, then DCR, then manual configuration. Crowi implements CIMD plus its existing seeded clients and does not publish a registration endpoint.

ChatGPT's authentication documentation prefers CIMD and supports `none` or `private_key_jwt` token-endpoint authentication. Crowi selects the public-client `none` flow with S256 PKCE. When the authorization server advertises RFC 9207 support, the documented client ID is `https://chatgpt.com/oauth/client.json` and redirect URI is `https://chatgpt.com/connector_platform_oauth_redirect`. Without it, they are `https://chatgpt.com/oauth/{callback_id}/client.json` and `https://chatgpt.com/connector/oauth/{callback_id}`. Crowi advertises RFC 9207 support from §15.2, before external onboarding exists, so ChatGPT is expected to use the fixed form; host admission accepts either form. ChatGPT's live document declares `token_endpoint_auth_method: "private_key_jwt"` with `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]`. OpenAI's guidance also requires every scope the server advertises to be enabled for the client. The cited OpenAI page is written for plugins and does not state that it covers custom connectors; live custom-connector verification is therefore a release requirement.

Claude.ai selects CIMD only when AS Metadata includes both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`; otherwise it attempts DCR. Its client ID is `https://claude.ai/oauth/mcp-oauth-client-metadata`, its documented callback is `https://claude.ai/api/mcp/auth_callback`, and its live document lists `authorization_code`, `refresh_token`, and the JWT-bearer grant with `token_endpoint_auth_method: "none"`. It uses S256, refreshes five minutes before access expiry and on `401`, and expects public-client refresh rotation. Its traffic originates from Anthropic's published egress range (`160.79.104.0/21`), and both the MCP server's and the authorization server's discovery endpoints must be reachable from it. The PRM `resource` must equal the URL the user enters, including its path.

### §1.3 Dependency boundary

`pnpm-workspace.yaml` and `pnpm-lock.yaml` resolve `@modelcontextprotocol/sdk` to 1.32.1 and `@hono/mcp` to 0.3.0. Neither SDK v1 nor v2 provides a server-side CIMD resolver, so Crowi owns resolution, local policy, and persistence. `@hono/mcp` supports SDK v1 only.

SDK v2 targets the 2026-07-28 protocol: stateless requests without `initialize` or session IDs, `server/discover`, and `Mcp-Method` headers. It also moves authorization-server helpers to legacy. Upgrading requires separate transport and adapter work; it is not a prerequisite or an implicit part of this RFC. Both target clients' cited documentation still refers to protocol 2025-11-25. Dependency compatibility with their evolving protocol support is an ongoing risk verified in §13 and §15.

### §1.4 Instance policy

Allowing an external client lets another service read or change wiki content as an authorizing user. Host admission and client approval are administrator decisions; user consent remains mandatory for external clients. Turning the master switch off blocks external authorization, exchange, refresh, and MCP use while preserving PATs and seeded first-party clients.

## §2 Goals and non-goals

### §2.1 Goals

- Let ChatGPT and Claude.ai start from only the public MCP URL, once an administrator has enabled and approved the integration.
- Implement PRM discovery and an RFC 6750 Bearer challenge.
- Resolve external URL-form client IDs through CIMD, restricted to administrator-allowed hosts, with durable local approval that snapshots the approved name and redirects, and durable revocation.
- Keep connected sessions independent of the vendor's metadata availability: only authorization and administrator add-by-URL fetch metadata.
- Bind authorization codes, refresh tokens, and access JWTs to the canonical MCP resource and validate issuer and audience at MCP; keep MCP-audience tokens out of public REST and out of in-process dispatch headers.
- Support first-party resource-bound OAuth before external discovery and onboarding are exposed.
- Offer initial read-only or read/write consent, defaulting to read/write subject to the administrator cap, with explicit scope negotiation for external clients.
- Enforce RBAC, token scope, and administrator policy together; make family, client, and global revocation block the next MCP request; revoke the family issued from a reused authorization code.
- Provide administrator inventory and user connection revocation; connections are not stored in a separate grant collection.
- Preserve PATs, seeded general-API OAuth behavior, split-origin deployments, and standalone MongoDB support.

### §2.2 Non-goals

- DCR, a public registration API, confidential external clients, or client-secret issuance.
- Metadata fetching from arbitrary hosts, native-app callbacks, custom URI schemes, or loopback HTTP redirects for external clients; these redirect forms remain available only to seeded first-party clients. Loopback-redirect CIMD clients such as Claude Code are therefore out of scope.
- Fetching CIMD documents at code exchange, refresh, or MCP requests.
- Tool-level OAuth step-up, a `_meta["securitySchemes"]` compatibility mirror, or local write elevation that cannot deliver credentials to the remote client.
- New tools or scopes, a general manual client-registration UI, or treating client-side action confirmation as Crowi authorization.
- Legacy `/sse`, SDK v2, or migration to the 2026-07-28 MCP transport and lifecycle.
- MongoDB transactions, issuance outboxes, repair workers, idempotent token-response recovery, or runtime replica capability checks.
- Deriving public identifiers from request headers or retaining `/api/v2` as an MCP audience.

## §3 Decision and end-to-end flow

1. The client calls the public Streamable HTTP MCP URL without credentials.
2. Crowi returns `401` with a Bearer challenge naming `resource_metadata` and the permitted initial scope set.
3. The client reads PRM, then AS Metadata with S256, public-client `none`, RFC 9207 support, and CIMD support.
4. The client submits its CIMD URL as `client_id`, the canonical `resource`, an exact redirect URI, state, requested scopes, and an S256 challenge.
5. Before the user authenticates, Crowi checks only the request syntax, the master switch, and the client-ID host against the allowlist. It fetches nothing and creates no record; failures render a neutral local error.
6. Crowi authenticates the user. `resolveOAuthClient` then fetches and validates the document and applies the durable client record. An unknown client gets a pending record that stores the requesting user; a pending client, a client whose redirects changed since approval, or a revoked or disallowed client cannot authorize.
7. Crowi creates a single-use, short-lived authorization context bound to the authenticating browser session, then displays the approved client name with its metadata host, the redirect origin, the resource, the signed-in account, the negotiated scopes, and a warning to continue only if the user started this connection from their own client. External consent is never skipped.
8. Consent creates a short-lived code bound to the client, user, exact redirect, selected scopes, PKCE challenge, and resource. The server builds every success and denial redirect to a validated callback, and each carries the exact issuer as `iss`.
9. The client exchanges the code with its verifier. Crowi atomically consumes the code, validates the binding against the durable client record, and issues an audience-bound access JWT and opaque rotating refresh token in a new family recorded on the consumed code. A second presentation of the code revokes that family.
10. MCP verifies the access JWT, client eligibility, family revocation, and current policy, then executes tools under the user's RBAC and effective scopes through a private in-process dispatch context.
11. Refresh retains client, family, and resource, uses only the durable client record and policy, and may only reduce scope. User family revocation, administrator client revocation, host removal, or master-off blocks subsequent use at the applicable boundary.
12. A missing tool scope returns an ordinary sanitized MCP `isError` result. Obtaining write access later requires a new normal authorization initiated by the client and explicit consent.

## §4 Trusted public URLs and discovery

### §4.1 URL builders and routing

One module derives public identifiers from trusted configuration:

| Value | Trusted source | Example |
|---|---|---|
| Authorization Server issuer | Normalized `CLIENT_URL` / `crowi.getBaseUrl()` | `https://wiki.example.com` |
| Canonical MCP resource | Normalized `MCP_PUBLIC_URL`, otherwise issuer + `/api/mcp` | `https://wiki.example.com/api/mcp` |
| PRM URL | MCP resource origin + `/.well-known/oauth-protected-resource` | `https://wiki.example.com/.well-known/oauth-protected-resource` |

`MCP_PUBLIC_URL` is an absolute HTTPS URL with no credentials, query, or fragment and no trailing slash. Loopback development may use HTTP. Invalid public configuration prevents external OAuth enablement. Request `Host`, forwarded-host headers, and other caller input never determine issuer, audience, or discovery URLs.

The canonical MCP resource is the URL users enter in their client, character for character. Operator documentation tells users to enter it exactly as the AI integrations page displays it, without a trailing slash; Claude.ai compares the PRM `resource` with the entered URL including its path.

Split-origin deployments may set `CLIENT_URL=https://wiki.example.com` and `MCP_PUBLIC_URL=https://mcp.example.net/api/mcp`. Resource metadata is served on the MCP origin and names the configured authorization-server issuer. Production and development proxies route both well-known aliases correctly, and every `/.well-known/*` path on both origins must be reachable from the target clients' egress ranges, including Anthropic's published range.

Public metadata, authorization, token, and MCP routes have explicit browser CORS handling, including preflight and exposure of `WWW-Authenticate`. Allowed browser origins are configured separately from CIMD hosts and callback URIs; none of these lists substitutes for another. Credentialed browser requests do not use wildcard origins. Existing seeded device routes retain their own policy.

### §4.2 Protected Resource Metadata

Serve the same RFC 9728 document at `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource{canonical-resource-path}`. The default path alias is `/.well-known/oauth-protected-resource/api/mcp`; it does not introduce another audience.

```json
{
  "resource": "https://wiki.example.com/api/mcp",
  "authorization_servers": ["https://wiki.example.com"],
  "scopes_supported": ["pages:read", "pages:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Crowi MCP"
}
```

PRM `scopes_supported` lists exactly the permitted external MCP set: `pages:read pages:write` under the default cap and `pages:read` under the read-only cap. Every scope it lists is one an approved CIMD client can receive, which satisfies OpenAI's requirement that advertised scopes be enabled for the client. AS Metadata `scopes_supported` keeps the full catalog because it also serves seeded clients; §8.2 narrows external requests drawn from it instead of rejecting them. Publish only implemented capabilities; external onboarding is not advertised before its resolver and policy are ready.

### §4.3 MCP challenge

Every MCP authentication `401` includes a Bearer challenge. Missing credentials return the permitted initial scope set, which is read/write under the default cap because this RFC does not implement tool step-up:

```http
WWW-Authenticate: Bearer resource_metadata="https://wiki.example.com/.well-known/oauth-protected-resource", scope="pages:read pages:write"
```

With the read-only cap, the challenge scope is `pages:read`. MCP clients take their initial request from the challenge `scope`, then from PRM `scopes_supported`. A client may request a smaller set. The consent screen remains authoritative about the actual scopes granted.

Malformed, expired, revoked, wrong-issuer, wrong-audience, or otherwise ineligible credentials return the same metadata and scope guidance plus `error="invalid_token"` and a neutral `error_description`. No error reveals whether a client or family exists. Database and infrastructure failures fail closed as server errors rather than being reported as bad credentials. User-status and tool-permission failures retain their distinct authorization errors.

### §4.4 Authorization Server Metadata and responses

AS Metadata retains the configured issuer and authorization-code, refresh-token, and applicable seeded-client capabilities. It includes:

```json
{
  "authorization_response_iss_parameter_supported": true,
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "client_id_metadata_document_supported": true
}
```

The CIMD flag is present and true only while the external feature is enabled and operational. With the switch off, Claude.ai falls back to DCR, finds no registration endpoint, and shows its generic authorization failure; operator documentation names this symptom. `authorization_response_iss_parameter_supported` is advertised from the phase that builds every success and denial redirect on the server with `iss` (§15.2); today the denial redirect is assembled in the browser (`packages/web/src/app/(auth)/oauth/authorize/page.tsx`). The S256 and `none` fields describe implemented authorization-server behavior independently of the switch. No `registration_endpoint` is advertised. Cached metadata never overrides current admission or revocation checks.

RFC 9207 `iss` is the exact metadata issuer in every successful and error authorization response delivered to a validated redirect URI, including denial. The server constructs these redirects; the browser navigates to the returned URL. Invalid or unvalidated redirects receive a local error page and no redirect. Web-session JWT issuer handling remains separate from OAuth authorization-response issuer identification.

## §5 CIMD resolution and local client policy

### §5.1 One client-resolution boundary

All OAuth client resolution uses:

```ts
resolveOAuthClient(clientId: string): Promise<OAuthClientResolution>
```

The normalized result contains client ID, display name, metadata host where applicable, exact redirect URIs, supported grant types and scopes, public/confidential type, seeded/CIMD source, trusted/first-party flags, and local approval state. Failures distinguish invalid or ineligible clients from temporary resolution failure internally; wire errors remain neutral `invalid_client` or an appropriate temporary failure.

Seeded first-party IDs resolve to their existing local records and capabilities. Other IDs must be eligible CIMD URLs. Shared authorize, token, consent, device, and administration code does not assume an opaque ID, reject URLs based on storage-derived syntax, or directly query clients outside the resolver/model boundary.

The resolver has two modes. Authorization after user authentication and the administrator add-by-URL action fetch and validate the document. Code exchange, refresh, MCP eligibility, and administrative lifecycle reads use only the durable client record and current policy and never fetch, so a vendor metadata outage leaves existing connections working.

### §5.2 Host admission and bounded fetch

The master switch defaults off. The administrator-managed allowlist starts empty and matches the normalized HTTPS hostname exactly, with no wildcard or implicit subdomain match. Admission is by host, not a complete metadata URL or path: ChatGPT's callback-specific form embeds a variable path. The original full URL remains the exact `client_id` identity. URLs must use HTTPS on the default HTTPS port and contain no credentials or fragment; IP literals are not accepted as external client hosts.

Before the user authenticates, the authorization endpoint checks only `client_id` syntax, enablement, and host admission. The fetch and any record creation happen after authentication. Before fetching, check enablement, the allowed hostname, and any existing local revocation. The same checks apply to an administrator adding a client by URL, so clients can be added and approved only while the master switch is on. Resolve the hostname, reject non-public IPv4 and IPv6 destinations, and pin the validated address to the connection while verifying TLS for the original hostname. Redirects are bounded and permitted only within the same HTTPS host under the same address and port checks; a redirect to another host is rejected even if that host is also allowlisted. This prevents DNS rebinding and redirects from bypassing host admission.

Use a five-second total fetch timeout, at most three redirects, and a 16 KiB maximum decoded response body. Accept only a valid JSON metadata object. Cache successful documents according to HTTP freshness and validation headers, honoring `no-store` and revalidation; expired metadata is not silently reused after a failed validation. Cache keys are exact client IDs. A cached document cannot override current host admission or durable revocation. Document-supplied logos, policy URLs, and key URLs (`logo_uri`, `jwks_uri`, and similar) are never fetched in this public-client flow.

### §5.3 Metadata validation

Require nonempty `client_id`, `client_name`, and `redirect_uris` of the correct JSON types. The document's `client_id` must equal the originally presented URL exactly, including after an allowed redirect; URL normalization is not an identity comparison. Bound names to 128 Unicode code points, redirect lists to five entries, and each URI to 2,048 bytes within the document-size bound.

External redirects must be absolute HTTPS URLs without credentials or fragments, and each redirect's host must equal the `client_id` host. Store and compare their exact strings; no wildcard, prefix, port-agnostic, or origin-only redirect matching is permitted. In the shared matcher `packages/api/src/util/oauth-redirect-uri.ts`, the loopback any-port branch and the custom-scheme branch apply only to seeded first-party clients; CIMD clients reach only the exact-string branch. Every authorization redirect must occur in the approved redirect snapshot (§5.4), and token exchange must match the redirect bound into its code. Metadata changes cannot rewrite a code's client, redirect, resource, or scopes.

Grant and authentication fields are validated individually:

| Field | Rule |
|---|---|
| `grant_types` | Must include `authorization_code`. Refresh tokens are issued only when it also includes `refresh_token`. Every other listed grant type is ignored and never enabled for the client. |
| `response_types` | When present, must contain `code`. |
| `token_endpoint_auth_method` / `token_endpoint_auth_methods_supported` | The public flow is used when the single-valued method is `none`, or when `none` appears in the supported list even if the single-valued method names another method such as `private_key_jwt`. A document offering neither is rejected. |

External clients therefore use the authorization-code grant, optional refresh, response type `code`, token authentication `none`, and S256 PKCE. No external record becomes trusted, first-party, confidential, or device-grant capable. Optional document scopes can narrow the supported MCP scopes but cannot expand them or confer consent.

### §5.4 Durable approval and revocation

Maintain one local `OAuthClient` record per exact CIMD `client_id`, protected by the existing unique identity constraint. Its source is CIMD, and its local status is `pending`, `active`, or `revoked`. A client first seen at authorization starts pending and stores the requesting user. An administrator can also add a client by URL from the AI integrations page; Crowi fetches and validates the document under the same rules and records it as active with the administrator as approver, so approval does not require a user to try first. Host admission permits resolution and does not replace per-client approval or user consent.

Approval snapshots the validated redirect URI set and client name. Authorization accepts only redirects in the approved snapshot, and consent displays the approved name with the metadata host. The record also keeps the most recently fetched metadata for inventory. A later fetch whose redirect set differs from the approved snapshot returns the client to pending, and authorization is rejected until an administrator re-approves the new set; a changed name alone is shown in inventory beside the approved name. Metadata refresh never clears local revocation, approves a pending client, or confers trust. Concurrent discovery must not overwrite administrator state. Revoked records are retained so fetching the same document cannot recreate an active client.

Client eligibility differs by path. Authorization requires an `active` client. Code exchange, refresh, and MCP require a client that is not `revoked`, current host admission, and the master switch; a client that has never been approved has no codes or connections, so returning an approved client to pending blocks new authorizations only. Existing connections keep their code-bound redirect and continue through exchange, refresh, and MCP, which use the durable record and never re-read metadata.

Removing a host immediately makes its CIMD clients ineligible for authorization, exchange, refresh, and subsequent MCP requests. Re-adding a host does not undo explicit client revocation, and approval applies only to pending clients. Revoked clients and token families are not reactivated by this flow. The name alone is not proof of identity; consent always pairs it with the metadata host.

## §6 Resource, issuer, and audience binding

### §6.1 Authorization and code exchange

Shared schemas accept an optional RFC 8707 `resource` to preserve seeded general-API flows. Accept one resource equal to the configured canonical MCP identifier after canonicalization: scheme and host compare case-insensitively and are lowercased; the path and everything else compare exactly. Reject multiple, unknown, fragment-bearing, or mismatched values.

A CIMD client's only audience is MCP, so an external authorization request that omits `resource` binds to the canonical MCP resource. A seeded authorization intended for MCP must send `resource`; a seeded request without it stays on the general-API path.

Preserve the resource through the validated authorization context, consent, authenticated submission, and the code record. Code exchange verifies client, redirect, S256 verifier, current client eligibility, and selected scopes. An absent `resource` at exchange defaults to the code's bound resource; a present value must canonicalize to it, and a mismatch returns `invalid_grant`. An unbound seeded code cannot be upgraded into MCP authority at exchange.

### §6.2 Refresh

Bound refresh rows retain the canonical resource alongside their client, user, scopes, authorization time, and prerequisite `familyId`. An absent `resource` on refresh defaults to the row's bound resource; a present value must canonicalize to it. Refresh requires the same client, inherits the family unchanged, and may only reduce scopes. Policy can further reduce the issued scope; the token response reports the actual scope. Increasing authority requires a new authorization and family.

Seeded clients that omit `resource` keep their general-API path, including existing device capabilities. Unbound refresh tokens cannot acquire an MCP resource during rotation. PATs remain a separate credential type without OAuth resource parameters.

### §6.3 OAuth access JWT

`signOauthAccessToken` takes the validated resource and family when issuing an MCP token. Resource-bound tokens use the configured public authorization-server issuer, not the web-session issuer, and contain:

```ts
{
  type: 'oauth_access';
  userId: string;
  scope: string;
  client_id: string;
  family_id: string;
  aud: 'https://wiki.example.com/api/mcp';
  iss: 'https://wiki.example.com';
  exp: number;
}
```

MCP-audience tokens carry no `email` claim: the user is resolved by `userId`, and no authentication path reads the address from an OAuth token, so the claim would only disclose it to the external client. The `TokenPayload` variant for resource-bound tokens reflects this.

The MCP access lifetime is the existing `ACCESS_TOKEN_TTL_SEC` default of one hour. Revocation does not depend on expiry: every MCP request checks family revocation, and for external clients also client status, host admission, and the master switch, so a revoked connection fails at its next request whatever the token's remaining lifetime. Each refresh inserts a successor row retained for the refresh-token lifetime, so a shorter access lifetime would multiply retained rows without improving revocation. Claude.ai refreshes five minutes before expiry, which the one-hour lifetime accommodates.

MCP verifies signature, exact issuer, exact audience (passed to the verifier as the audience option), expiry, token type, user status, client eligibility, and family revocation. The family claim lets the prerequisite's durable revocation record also fence MCP access JWTs; this request-time check is supplied by this RFC, not by the prerequisite. Seeded general-API access JWTs retain their existing issuer, claims, and expiry behavior.

### §6.4 Audience isolation and dispatch

Public REST credential resolution rejects any `oauth_access` token that carries an `aud` claim, whatever its issuer. This is an explicit check after decoding, because issuer verification alone admits a token from the REST issuer and `jsonwebtoken` ignores `aud` without an audience option. MCP must not forward an MCP-audience token as a general-purpose credential or pass it to another resource server.

MCP's in-process Hono dispatch carries a private resolved-auth context associated with the actual constructed `Request` through a module-private `WeakMap`. The dispatcher does not set an `Authorization` header on dispatched requests. A dispatch-only middleware that runs before any route authentication reads and deletes the entry once and installs a request variable holding the authenticated user, effective scopes, and an `authContext` whose kind is `oauth` or `pat`, never `web`. `createJwtAuth` recognizes that variable, so authentication middleware that runs more than once on one dispatched request (overlapping route prefixes, `createJwtAdminRequired` wrapping `createJwtAuth`) reuses it instead of falling back to header authentication. Because the kind is never `web`, web-session-only routes such as `createJwtAdminRequired` still refuse MCP callers. Public requests cannot supply this context through headers, query, body, or another serializable marker. Public requests without a private entry follow normal authentication, which rejects the MCP audience. The context never skips RBAC or route scope checks.

## §7 MCP credential boundary

Extend the existing `createMcpAuth` to accept valid Bearer PATs and `oauth_access` JWTs only when bound to the canonical MCP audience. Keep cookie eligibility disabled. A malformed Authorization header never falls back to a valid session cookie, and web-session `type: 'access'` JWTs remain invalid even in a Bearer header.

PAT resolution and revocation remain unchanged. Seeded resource-bound OAuth uses its client and family checks without the external master switch or host allowlist. External OAuth additionally checks that the client is not revoked, current host admission, master enablement, and the current scope cap, all from durable state (§5.4). Unbound and wrong-resource OAuth remain rejected.

## §8 Scope selection and tool authorization

### §8.1 Scope and RBAC

| Tools | Required scope |
|---|---|
| Page reads, lists, history, backlinks, autocomplete, and search | `pages:read` |
| Create, update, rename, delete, restore, and revert | `pages:write` |

Existing tool descriptors and Hono handlers define required scopes. No new scopes or RBAC bypass are introduced. Effective access is RBAC decision ∩ token scope ∩ administrator cap, with seeded and PAT policy applied according to their existing boundaries. A token scope never grants access to a page the user cannot access.

### §8.2 Scope negotiation and initial consent

External clients negotiate against the permitted external set, which is `pages:read pages:write` under the default cap and `pages:read` under the read-only cap. An omitted `scope` requests the permitted set. Requested scopes outside the permitted set, including unknown or catalog scopes outside MCP and write above a read-only cap, are dropped rather than rejected, and consent shows the narrowed set. A request left with no permitted scope after narrowing is treated as omitted, and consent preselects read-only in that case. Seeded clients keep the existing strict rule in `validateClientAndScopes` (`packages/api/src/hono/handlers/oauth.ts`), which rejects any scope outside the client's allowed set.

The initial choice is `pages:read` or `pages:read pages:write`. Default to read/write when the negotiated request includes write; an explicit read-only request stays read-only. A read-only administrator cap forces the consent and issued token to read-only. The user may choose a smaller permitted set, never more than negotiated, and the token response reports the exact granted scope.

Consent shows the approved client name and metadata host, external-client badge, exact redirect origin, MCP resource, the signed-in account, and selected authority. It explains that wiki content may be sent to the external service and that writes change Crowi as the user, and warns the user to continue only if they started this connection from their own client. External clients never skip consent.

### §8.3 Missing scope and future step-up

Missing scope produces an ordinary sanitized MCP `isError` tool result for both OAuth and PAT callers. This RFC emits neither tool-level OAuth challenges nor `_meta["mcp/www_authenticate"]`. Tool annotations continue to describe actual read/write/destructive behavior without implying an authorization channel.

Top-level tool `securitySchemes` together with `_meta["mcp/www_authenticate"]` step-up is documented by OpenAI and remains separate future work. SDK v1 1.32.1 drops top-level `securitySchemes` from `tools/list`, so that work needs an explicit wire implementation and live client tests. The documentation provides no basis for a `_meta["securitySchemes"]` mirror, and this RFC emits none.

### §8.4 Administrator cap changes

Setting the cap to read-only removes write from PRM, the challenge, and initial consent, masks write from existing external tokens, and restricts refresh output to read-only. Existing tokens may still perform authorized reads; write calls return an ordinary policy-denied tool error without reauthorization instructions. Returning the cap to read/write does not enlarge existing token scopes or reverse refresh downscoping; write authority absent from a connection requires fresh consent.

## §9 Data model and token lifecycle

### §9.1 Client records

Extend `OAuthClient` with source (`seeded` or `cimd`), status, the approved name and redirect snapshot, the most recently validated CIMD metadata, allowed scopes and grants, the requesting user or adding administrator, approval/revocation actors and timestamps, and authorization/use timestamps for inventory. Seeded rows are backfilled idempotently as active with their existing capabilities. Local identity is the exact `client_id`; metadata cache expiry does not delete approval or revocation state.

### §9.2 Connections are refresh-token families

Connections are not stored in a separate grant collection. Each successful authorization starts a new prerequisite `familyId`; rotation, including concurrent forks, retains it. The existing refresh rows already identify user, client, scopes, and authorization time; this RFC adds resource binding. These rows plus the client record and durable `OAuthTokenFamilyRevocation` record supply the information needed for connection inventory and revocation.

Connected apps derives live connections from eligible refresh tips and groups rows by family where appropriate. Separate authorizations remain separate connections; revoking one does not revoke a later consent or another sign-in. The existing public session identifier remains a refresh-row `_id`, not a new public family ID. The server verifies ownership, resolves that row's family, and invokes the prerequisite revocation operation. Administrator inventory derives connected users from the same rows and does not promise permanent connection history after token TTL expiry.

The prerequisite's family revocation records have no TTL. This RFC uses their presence for MCP access-JWT checks even after refresh rows expire. It does not add a positive family registry or require a refresh row to survive as an access-token validity anchor.

### §9.3 Code exchange and refresh rotation

Keep `OAuthAuthorizationCode.consume` in `packages/api/src/models/oauth-authorization-code.ts`: its single `findOneAndUpdate` atomically sets `consumedAt` only for an unconsumed, unexpired code. One exchange wins. Binding or policy validation after consumption can burn the code, and a crash or lost response requires a new authorization; issued tokens are not stored for replay.

Code reuse revokes the family issued from the code (RFC 6749 §4.1.2). The exchange generates the `familyId` before issuance, and the same atomic consumption stamps it on the code row and extends that row's expiry to ten minutes after consumption; a consumed row is never usable, so the extension only lengthens the detection window beyond the code's one-minute lifetime. When `consume` returns nothing, the token endpoint looks up a consumed row by code hash; if that row carries a `familyId`, it invokes the prerequisite `revokeFamily` for the row's user before returning `invalid_grant`. A reuse after the row's expiry is indistinguishable from an unknown code and returns `invalid_grant`.

Use the prerequisite token-family implementation for refresh rotation, replay/grace behavior, and family revocation. It persists a family revocation record before bulk-revoking existing rows and checks that record both at refresh entry and after successor insertion. It preserves its existing rotation behavior, including possible concurrent forks; this RFC does not promise a single CAS winner for refresh or add an idempotency protocol.

Resource, client, and selected scope are validated before issuance and preserved on the successor. Client eligibility and current administrator policy are checked again from durable state before a response is returned. If a durable family revocation is observed after insertion, no token pair is returned, following the prerequisite. A request that already passed its final check can finish concurrently with revocation; the next MCP request and any later refresh still reject the revoked family.

### §9.4 Revocation and request-time policy

User connection revocation uses the prerequisite's owner-checked family operation. For MCP, every subsequent access request additionally checks `OAuthTokenFamilyRevocation` for the signed user/family pair. This gives MCP stronger access revocation than seeded general-API JWTs, which remain valid until their existing expiry unless otherwise invalidated.

Administrator client revocation changes the durable client status and blocks all its users at authorization, exchange, refresh, and the next MCP request. Master-off and host removal apply the corresponding current policy to all CIMD clients. Restoring enablement or host admission can resume otherwise eligible unexpired connections; it never clears explicit client or family revocation.

Store external policy through the existing typed configuration system. Security-sensitive eligibility checks read authoritative durable client, family-revocation, and policy state from the primary; process caches and Redis notifications are optimizations, not the basis for revocation. A database failure cannot be treated as an active client, an unrevoked family, or an enabled policy. Request-time family, client, and policy checks replace a per-JWT denylist.

### §9.5 Retention and deployment

Usable-code and refresh-token lifetimes are unchanged; refresh rows retain their existing 30-day lifetime, and a consumed code row is retained for ten minutes after consumption (§9.3). Retain local client revocation records and the prerequisite's permanent family revocation records. Metadata caching follows HTTP headers independently of local lifecycle state. Token issuance relies on existing TTL sweeps for cleanup.

The prerequisite boot migration revokes family-less refresh tokens rather than backfilling possibly disconnected chains. It runs before listening, and existing OAuth clients sign in once after that upgrade. This RFC adds its client backfill and resource-aware fields through the existing migration framework without reimplementing family migration.

Deployment is a maintenance procedure: disable external OAuth if necessary, stop all old API replicas, start the new build with boot migrations, verify the deployment, then enable external access. Rollback likewise disables external access and stops the current replicas before starting the selected build. Skipping the stop step leaves old writers/verifiers outside the new authorization guarantees and may cause reconnects or inconsistent policy enforcement. The design includes no runtime replica or fleet check.

## §10 Administrator and user experience

### §10.1 Placement and settings

Add **AI integrations** to administrator navigation under Authentication, before Plugins. The web route is `/admin/ai-integrations`; API contracts use `/admin/ai-integrations/*` under the canonical `/api` mount and `createJwtAdminRequired(crowi)`.

| Setting | Values | Default |
|---|---|---|
| Allow external MCP OAuth clients | On/off | Off |
| Allowed client metadata hosts | Exact HTTPS hostnames | Empty |
| Maximum external scope | Read-only / allow read/write | Allow read/write |

The master switch and the empty allowlist keep external access closed until an administrator opens it; the scope cap then defaults to read/write, matching the consent default. The page shows the resolved issuer, MCP resource (the exact URL users enter), and metadata URL, explains host matching, and validates the full policy before saving. It also explains that with the switch off Claude.ai reports a generic authorization failure, and that Anthropic's egress range must reach the `/.well-known/*` endpoints.

### §10.2 Client inventory

Show the approved name with metadata host, the current metadata name when it differs, full client ID, seeded/CIMD source, pending/active/revoked state, approved and currently published redirects, supported scopes, the requesting user or adding administrator, approval/revocation actors and times, and authorization/use times. Show current connections and connected users with their resource and scopes, derived from retained refresh rows. Treat names and all remote metadata as text, never executable markup.

Actions add and approve a client by URL, approve a pending client (including re-approval after a redirect change), revoke a client, or inspect its connections. There are no client-secret, trust-elevation, or source-conversion actions.

### §10.3 Connected apps

Provide `/me/connected-apps` and web-session-only, owner-checked list/revoke APIs using the existing OAuth-session surface where possible. Show client name and host, resource, scopes, authorization time, and available usage information. Revoke the selected connection's entire family, including forked refresh rows and its MCP access JWTs. General-API JWTs keep their existing expiry-based revocation.

There is no local write-elevation button. A user needing more scope starts a new OAuth authorization through the external client's supported connection flow. Reconnecting creates a new family and requires consent.

### §10.4 Consent and redirect safety

The UI supports pending approval, read-only consent, read/write consent, and policy-denied/revoked states. A server-validated authorization context carries the exact redirect, client, resource, negotiated scopes, PKCE challenge, and state across login and consent. The context is single-use, expires after a few minutes, and is bound to the browser session that authenticated; submitting it from another session or a second time fails with a neutral local error. Completion and denial revalidate current client policy. The server builds the terminal success or denial redirect with `iss`; the browser does not assemble a redirect from raw query parameters.

A vendor-shared client ID such as ChatGPT's identifies the vendor, not the person who started the flow, so an attacker can send a victim an authorization link that delivers the code to the attacker's connection. The session-bound single-use context, the signed-in account named on consent, and the warning to continue only when the user started the connection from their own client mitigate this consent phishing.

Replace arbitrary public client-info lookups with this validated context so an arbitrary `client_id` is not a client-name/status oracle. Unvalidated or ineligible requests receive neutral local errors; errors and denials redirect only to a validated callback and include RFC 9207 `iss` whenever an authorization response is sent there.

Every authorize, login/continue, and consent route involved in this flow sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` before authentication redirects. Consent submission retains web-session authentication and CSRF protection.

## §11 Component boundaries

| Component | Responsibility |
|---|---|
| `@crowi/api-contract` | PRM, AS Metadata additions, resource-aware authorize/token schemas, validated authorization context, admin policy/client inventory/add-by-URL, and user connection contracts |
| API OAuth implementation | Trusted URL builders, CIMD resolver/cache, local client policy and approval snapshots, scope negotiation, PKCE/resource binding, server-built issuer responses, code-reuse family revocation, and family-aware token issuance |
| MCP authentication and dispatch | Bearer credential boundary, audience/issuer/family/client checks, challenge, effective scopes, and private single-use in-process auth context |
| REST authentication | Rejection of every `oauth_access` token carrying `aud` |
| Existing family implementation | Family IDs, rotation/replay semantics, durable revocation with post-insert checks, and legacy boot migration |
| Web | Consent, AI integrations administration, Connected apps, and translations |
| Operations documentation | HTTPS/proxy/CORS configuration, same/split-origin URLs, the exact URL users enter, egress reachability of `/.well-known/*`, allowed hosts and approval, scope selection, revocation guarantees, switch-off symptoms, maintenance upgrade, and ChatGPT/Claude.ai walkthroughs |

Regenerate OpenAPI artifacts with `pnpm check:openapi` for contract or route changes. Existing production and development proxy support for `/.well-known/*` must be verified for both aliases. SDK helpers may supply validated wire types but do not replace Crowi's resolver, lifecycle, consent, or policy.

## §12 Security and failure handling

### §12.1 Metadata fetch and client identity

Host admission, fetching only after user authentication or administrator action, HTTPS, public-address validation at connection time, same-host redirect checks, and bounded HTTP fetching constrain CIMD's outbound request surface. HTTP caching reduces repeated fetches without weakening durable policy. Token and authorization endpoints retain endpoint-appropriate abuse limits.

CIMD ties metadata to an administrator-allowed HTTPS host but does not authenticate every bearer of a public client ID as that vendor. Redirect hosts equal to the `client_id` host, exact matching against the approved redirect snapshot, mandatory consent, and S256 bind code delivery and exchange. A redirect change requires re-approval, so a compromised or changed document cannot silently redirect new codes. Consent shows the approved name with the host and the signed-in account, and the session-bound authorization context limits consent phishing (§10.4). Document changes cannot confer local approval or undo revocation.

### §12.2 Authorization boundaries

Trusted configuration supplies all public identifiers. Resource binding is checked at authorization, code exchange, refresh, and MCP acceptance. REST rejection of audience-bearing OAuth tokens and the private internal dispatch context prevent token passthrough or expansion into general API access; dispatched requests carry an `oauth` or `pat` context, so web-session-only routes stay closed. Cookies and web-session JWTs remain outside MCP authentication. MCP-audience tokens carry no email address.

RBAC and route scope enforcement remain authoritative. External result sanitization and prompt-injection handling from RFC-0011 remain applicable but do not replace authorization. Read-only policy and missing scope produce ordinary tool errors, not instructions to bypass consent.

### §12.3 Recoverable failures

A consumed code or lost refresh response cannot be recovered by reissuing its plaintext from durable storage. The user reconnects. An orphaned hashed refresh row remains subject to normal TTL and client/family/policy checks until it expires. Logs never include authorization codes, access JWTs, refresh plaintext or hashes, or raw metadata-fetch errors containing sensitive request data.

Unavailable or invalid metadata blocks new authorization and administrator add-by-URL rather than redirecting to unvalidated locations. Code exchange, refresh, and MCP use the durable client record and policy, so a vendor metadata outage does not affect connected sessions. Revocation-record or policy-read failure blocks access; a network/cache failure cannot reactivate a client. A request already in flight at revocation may finish, but subsequent MCP requests are denied.

## §13 Verification requirements

### §13.1 Discovery and credential boundary

- Assert exact root/path PRM equality, canonical resource/issuer, the resource equal to the configured URL without a trailing slash, same/split-origin proxy behavior, CORS preflight, and exposure of `WWW-Authenticate`.
- Verify PRM `scopes_supported` and the challenge `scope` equal the permitted external set under each cap, while AS Metadata keeps the full catalog.
- Verify AS Metadata advertises S256 and `none` independently of external enablement, RFC 9207 support only once server-built redirects with `iss` exist, and CIMD only while enabled; it never advertises a `registration_endpoint`.
- Verify `iss` on every server-built successful/error authorization redirect, including denial, and no redirect when callback validation fails.
- Assert challenges for missing, malformed, expired, revoked, wrong-issuer, and wrong-audience credentials, with policy-appropriate scope guidance.
- Confirm cookies and web-session Bearer tokens fail even when otherwise valid; PATs and correctly bound OAuth succeed. Infrastructure errors fail closed without becoming misleading `invalid_token` responses.
- Forge Host/forwarded-host headers and serializable dispatch markers; confirm none change identifiers or authorize public REST use of MCP tokens.

### §13.2 CIMD and local lifecycle

- Exercise every OAuth path through `resolveOAuthClient` with seeded IDs, CIMD URLs, and neutral resolution errors; confirm exchange, refresh, and MCP succeed for an approved client while its metadata URL is unreachable.
- Confirm an unauthenticated authorization request performs no fetch and creates no record, and that the record created after authentication stores the requesting user.
- Test empty allowlist, exact host matching, callback-specific paths, forbidden subdomains/ports, public IPv4/IPv6 checks, DNS rebinding, same-host redirects, and cross-host rejection.
- Test fetch timeout/size/redirect limits, malformed JSON, missing required fields, exact document `client_id`, exact redirects, redirect hosts differing from the `client_id` host, and HTTP freshness/revalidation/`no-store`.
- Test field-level validation: `grant_types` without `authorization_code` is rejected; without `refresh_token` no refresh token is issued; extra grant types are ignored and never enabled; `response_types` without `code` is rejected; `none` is accepted from either the single-valued method or the supported list; a document offering neither is rejected.
- Use both live documents as fixtures. ChatGPT (`https://chatgpt.com/oauth/client.json`): single-valued method `private_key_jwt`, supported `["none", "private_key_jwt"]`, grants `authorization_code` and `refresh_token`, `jwks_uri` and `logo_uri` present; it resolves to the public flow without fetching keys or logos or requiring an assertion. Claude.ai (`https://claude.ai/oauth/mcp-oauth-client-metadata`): method `none`, no supported list, grants including `urn:ietf:params:oauth:grant-type:jwt-bearer`; it resolves with that grant ignored. Both redirect hosts equal their `client_id` hosts.
- Confirm loopback any-port and custom-scheme redirect matching apply only to seeded first-party clients; a CIMD document listing a loopback or custom-scheme redirect is rejected.
- Test concurrent local record creation, pending approval, administrator add-by-URL as active, approval snapshots, a changed redirect set returning the client to pending and blocking new authorization while existing connections keep exchanging, refreshing, and calling MCP, a changed name not altering consent, revocation surviving metadata refresh, and host removal/re-addition without clearing client or family revocation.
- Confirm external clients cannot become seeded/trusted, skip consent, or use device grants; consent renders name, host, and signed-in account safely.

### §13.3 Resource and token lifecycle

- Carry the exact resource through context, consent, code, exchange, refresh, JWT audience, and MCP validation; reject multiple/mismatched resources and attempts to upgrade an unbound seeded token.
- Confirm an external authorization without `resource` binds to the MCP resource, and an exchange or refresh without `resource` uses the bound resource; confirm case-differing scheme/host canonicalize and path differences are rejected.
- Verify exact public issuer, the one-hour default access expiry, client and family claims, absence of `email` on MCP-audience tokens, and separation from seeded general-API and web-session verification.
- Confirm public REST rejects every `oauth_access` token carrying `aud`, including one signed with the REST issuer, while private dispatch succeeds and still enforces scope and RBAC.
- Confirm dispatched requests carry no `Authorization` header, the private context is consumed exactly once, its `authContext.kind` is `oauth` or `pat`, and web-session-only routes such as admin routes refuse it.
- Confirm refresh inherits family/resource/client, cannot add scope, respects the current cap, and returns the actual issued scope.
- Preserve seeded general-API authorization/device/refresh behavior and PAT behavior, accounting for the prerequisite's one-time legacy sign-in requirement.

### §13.4 Atomic consumption and family revocation

- Run against standalone MongoDB; concurrent exchanges produce one `consume` winner and the loser gets `invalid_grant`. Because the loser's reuse handling revokes the family stamped on the code, the winner's tokens are also refused: either issuance fails its post-insert revocation check or the next refresh and MCP request fail.
- Present a consumed code again within ten minutes and confirm the family issued from it is revoked and the issued access and refresh tokens fail at their next use; a code reused after its row expires returns `invalid_grant` without side effects.
- Inject a crash or response loss after code consumption and during refresh; verify reconnecting restores access.
- Reuse the prerequisite's deterministic concurrent-fork and revoke-before/after-successor-insert tests; no test assumes a new refresh CAS or changes the existing grace behavior.
- Verify owner-scoped family revocation blocks all forks, post-insert family checks prevent a late usable refresh token, and MCP rejects a previously issued access JWT at its next request.
- Confirm durable client, host, and master policy block later issuance/use despite cached metadata; persistence failures never default to eligible.
- Verify boot migration and the maintenance deployment instructions.

### §13.5 Scope, UI, and interoperability

- Test scope negotiation: omitted scope yields the permitted set, a request left empty after narrowing preselects read-only on consent, unknown and above-cap scopes are dropped and the narrowed set shown on consent, seeded clients still reject unknown scopes; then the initial read-only/read/write choice, read/write default, forced read-only cap, exact token scope, cap changes on existing tokens, and RBAC denial despite sufficient scope.
- Assert real `tools/list` and `tools/call` behavior on SDK 1.32.1: annotations reflect behavior, no security-scheme mirror is emitted, and missing scope gives ordinary `isError` without tool-level step-up metadata.
- Test approval, add-by-URL, client inventory, user ownership checks, connection-family revoke, anti-framing, CSRF, and server-built success/deny/error redirects.
- Test the authorization context: single use, expiry, and rejection when submitted from a different browser session.
- Automate discovery → CIMD → approval/consent → PKCE/resource exchange → MCP initialize/list/read/write → refresh → family/client/global revocation on protocol 2025-11-25.
- Verify live ChatGPT custom connectors and Claude.ai, including actual CIMD URL/callback, metadata selection, whether `resource` is sent, scope choice, expiry/401 refresh, reconnect behavior, and the switch-off symptom. Custom-connector compatibility is confirmed live; the plugin guide alone does not establish it.
- Run targeted tests, type-check, lint, build, and OpenAPI checks appropriate to each implementation phase before external enablement.

## §14 Alternatives considered

### §14.1 Allowlisted CIMD with local client records — selected

CIMD follows the current MCP recommendation and both initial clients' preferred path. Host admission bounds metadata retrieval and accommodates callback-specific paths; durable local records supply approval snapshots, revocation, and inventory independently of remote metadata caching and vendor availability. `resolveOAuthClient` keeps the rest of OAuth independent of client identity representation.

### §14.2 Public DCR — rejected

MCP 2026-07-28 deprecates DCR for new implementations and retains it only as an optional compatibility mechanism. Both target clients support CIMD, so a public registration endpoint, activation modes, anonymous-registration abuse controls, quotas, and cleanup add no required initial capability. DCR may be added later behind the same resolver if a concrete client requires it.

### §14.3 DCR plus CIMD — rejected

Supporting both carries the registration and outbound-fetch surfaces together. The initial interoperability targets need only CIMD. Adding another resolution source later does not require changing authorization, consent, or token identity rules.

### §14.4 Grant collection, outbox, and repair workers — rejected

A separate `OAuthGrant` collection would duplicate the ownership and revocation boundaries that refresh-token families and their revocation records already provide, and would need cross-document synchronization with them. Durable token-response recovery would add collections, operation states, worker ownership, and a replay protocol to a flow where a rare crash is recoverable by reconnecting. Atomic code consumption, code-reuse family revocation, and the prerequisite's family revocation with post-insert checks cover single-use and revocation safety.

### §14.5 Tool-level step-up — deferred

Top-level `securitySchemes` and tool-result `_meta["mcp/www_authenticate"]` form a documented client-specific path, but SDK v1 drops the top-level field on `tools/list`. Implementing that wire contract and testing live client token delivery is separate work. Initial scope selection suffices for this RFC. A local write-elevation button is also excluded because it cannot deliver new credentials to a remote client.

### §14.6 Other excluded mechanisms

- Manual preregistration alone does not deliver URL-only onboarding for external clients; seeded first-party records and administrator add-by-URL of CIMD clients remain supported.
- Discovery alone cannot complete client resolution or issue an audience-bound token; it is implemented after the first usable OAuth-for-MCP phase.
- Legacy `/sse` does not solve OAuth; Streamable HTTP stays in place.
- Request-host URL derivation permits issuer/audience poisoning; trusted configuration handles split origins.
- Transactions and runtime replica checks add topology or runtime requirements; single-document consumption, the family prerequisite, and a stop-all/start-new maintenance procedure suffice.
- A shorter access-token lifetime does not provide next-request revocation and multiplies retained refresh rows; durable family/client/policy checks provide revocation without a per-JWT denylist.
- Fetching CIMD metadata at exchange, refresh, or MCP requests would make connected sessions depend on vendor availability; the durable record carries what those paths need.
- SDK v2 and the 2026-07-28 MCP lifecycle require separate transport work and adapter support; this RFC stays on the locked v1 stack.

## §15 Phased implementation plan

External OAuth remains off throughout development. Each phase has its own verification, and metadata never claims an unimplemented capability.

### §15.0 Prerequisites and sequencing

The refresh-token family feature, including its durable revocation record, post-successor-insert check, and boot migration, lands first. The `/api` migration, RBAC, and PAT-only `createMcpAuth` boundary are satisfied foundations. Coordinate with `feature-rbac-cli-permissions-cli-mcp`, whose PAT-only assumption changes in the first phase. Pin implementation and wire tests to SDK 1.32.1 / `@hono/mcp` 0.3.0 and protocol 2025-11-25; the later protocol migration is separate work.

### §15.1 Audience-bound OAuth access for first-party MCP

Implement trusted issuer/resource builders and resource propagation with canonicalization and absent-resource defaults through authorization, consent, code exchange, and refresh for seeded authorization-code clients. Extend `signOauthAccessToken` to write the validated resource as audience, carry the family, and omit `email` on MCP-audience tokens, keeping the one-hour default lifetime. Extend `createMcpAuth` to accept `oauth_access` only with the matching issuer/audience and valid client/family, while preserving PAT and cookie/web-session rejection. Add REST rejection of audience-bearing OAuth tokens, replace header forwarding in `dispatch.ts` with the single-use private dispatch context that keeps `oauth`/`pat` kinds, and add code-reuse family revocation.

This is the first usable increment: first-party clients can authorize for the MCP resource and call MCP over OAuth. Seeded general-API flows remain explicit and cannot turn unbound tokens into MCP tokens. External discovery and onboarding remain unavailable.

### §15.2 Discovery, challenges, and issuer identification

Add RFC 9728 root/path metadata with the permitted external scope set, exact MCP `401` challenges and scope guidance, proxy/CORS coverage, and S256/public-client AS Metadata. Move success and denial redirect construction to the server with RFC 9207 `iss`, and advertise `authorization_response_iss_parameter_supported` in this phase once those redirects exist. CIMD is not advertised until its resolver and enablement checks exist.

### §15.3 CIMD, allowed hosts, and durable clients

Centralize OAuth resolution, implement bounded public-address HTTPS fetching after user authentication and HTTP caching, validate documents field by field, enforce redirect-host equality and exact matching, restrict the matcher's loopback and custom-scheme branches to seeded first-party clients, add the empty host allowlist and disabled-by-default policy, and persist local client records with requesting user, approval snapshots, and revocation state. Add durable-record eligibility checks to authorize, token, refresh, and MCP, and external scope negotiation. Keep the CIMD flag conditional on feature enablement.

### §15.4 Consent and administrator/user UI

Implement single-use, session-bound authorization contexts, external name/host/account and content disclosure with the consent-phishing warning, read-only/read/write selection with the administrator cap, approval and re-approval, add-by-URL, inventory, and Connected apps list/family revoke. Add anti-framing/CSRF coverage, translations, and ordinary missing-scope tool errors. Keep external access disabled while this phase is incomplete.

### §15.5 Interoperability verification

Run the automated end-to-end flow and live ChatGPT custom-connector and Claude.ai checks on protocol 2025-11-25. Verify actual CIMD selection, callback/issuer behavior, whether `resource` is sent, read/write authorization, read-only policy, refresh timing and rotation, revocation, reconnect after lost responses, and the switch-off symptom. Document same/split origins, the exact URL users enter, egress reachability of `/.well-known/*`, allowed hosts, per-client approval and add-by-URL, scope and revocation behavior, and the stop-all/start-new upgrade procedure.

### §15.6 Enablement

After interoperability and implementation gates pass, an administrator may enable the feature, add intended metadata hosts, and approve resolved clients or add them by URL. No hosts or active external clients are shipped by default. Enabling uses normal durable administrator policy. Record SDK/protocol migration as separate dependency work without gating this RFC on v2.

## §16 Resolved decisions and open questions

### §16.1 Resolved decisions

1. External onboarding is CIMD only; DCR is excluded unless a future concrete compatibility need justifies it behind the resolver.
2. The master switch defaults off, the exact-host allowlist starts empty, and durable local records retain per-client approval and revocation. Approval snapshots the name and redirect set; a changed redirect set returns the client to pending, which blocks new authorization while exchange, refresh, and MCP require a non-revoked client plus current host admission and the master switch. Administrators can add and approve a client by URL.
3. `resolveOAuthClient` is the single resolution boundary for CIMD and seeded first-party clients; remote metadata never overrides local lifecycle state. Metadata is fetched only after user authentication at authorization or by administrator add-by-URL; exchange, refresh, and MCP use the durable record.
4. CIMD documents are validated field by field: `authorization_code` is required, `refresh_token` enables refresh, other grants are ignored, `response_types` must contain `code` when present, and `none` is accepted from the single-valued method or the supported list. Redirect hosts equal the `client_id` host and match exactly; loopback and custom-scheme matching stay with seeded first-party clients.
5. Resource-aware OAuth access is the first implementation phase and enables first-party MCP use before external onboarding.
6. RFC 8707 resource binding and exact issuer/audience validation are mandatory for MCP OAuth. External authorization without `resource` binds to MCP; exchange and refresh without `resource` use the bound value; scheme and host compare case-insensitively. PATs remain separate and cookies/web-session Bearer remain rejected.
7. Public REST rejects every `oauth_access` token carrying `aud`. MCP dispatch uses a single-use private context with `oauth`/`pat` kinds and forwards no Bearer header. MCP-audience tokens carry no `email`.
8. MCP access tokens keep the existing one-hour default lifetime; per-request family, client, and policy checks provide revocation.
9. Initial authorization offers read-only or read/write and defaults to read/write when permitted. The administrator cap defaults to read/write. External scope requests are negotiated by narrowing; PRM advertises only the permitted external set. Missing tool scope returns an ordinary error.
10. The authorization context is single-use, short-lived, and bound to the authenticating browser session; consent names the signed-in account and warns against connections the user did not start.
11. Tool-level step-up and top-level `securitySchemes` are deferred; no `_meta["securitySchemes"]` mirror is supported.
12. Connections are refresh-token families plus local client records; there is no separate `OAuthGrant`. The prerequisite supplies refresh revocation, and this RFC adds family checks to MCP access JWTs and family revocation on authorization-code reuse.
13. Keep atomic code `consume` and prerequisite refresh rotation without outboxes, repair workers, or a new refresh idempotency protocol. A lost mid-flow response can require reconnecting.
14. Standalone MongoDB is supported. Deployments stop old replicas and start the new build with boot migrations; no runtime fleet gate is designed.
15. AS Metadata advertises S256 and `none`; RFC 9207 support is advertised from the phase where the server builds every success and denial redirect with `iss`. CIMD support is advertised only while enabled.
16. SDK 1.32.1 and `@hono/mcp` 0.3.0 remain on MCP protocol 2025-11-25. Neither SDK major supplies server-side CIMD resolution; v2/2026-07-28 migration is separate work and a dependency risk.
17. The `/api` migration, PAT-only MCP boundary, and RBAC are satisfied. Effective access is RBAC ∩ token scope ∩ applicable administrator cap; coordinate the PAT-only assumptions in `feature-rbac-cli-permissions-cli-mcp` before §15.1 lands.
18. Public identifiers come from trusted configuration, including `MCP_PUBLIC_URL` for split origins; the PRM `resource` equals the URL users enter.
19. Claude Code and other loopback-redirect CIMD clients are excluded by design.

### §16.2 Remaining validation

No architecture decision remains open. Live ChatGPT custom-connector behavior is a required interoperability check because the cited authentication guide is plugin-specific. Claude.ai's CIMD selection, refresh behavior, and whether it sends `resource` at authorization and token requests also require live verification; the design accepts either. Claude Code, which uses a loopback-redirect CIMD document, is excluded by design and is not part of these checks. These are release acceptance checks. Future SDK/protocol migration and tool step-up have separate scope.

## §17 References

- [RFC 6749: OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750)
- [RFC 7636: Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://www.rfc-editor.org/rfc/rfc7591) — compatibility alternative, not implemented here.
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 9207: OAuth 2.0 Authorization Server Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [OAuth Client ID Metadata Document (Internet-Draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
- [MCP Authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) — current authorization requirements and recommendations.
- [MCP Client Registration, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) — CIMD validation, domain policy, selection priority, and DCR deprecation.
- [MCP Authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) — protocol baseline retained for this implementation, including scope selection and resource canonicalization.
- [OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth) — plugin documentation for CIMD, callbacks, S256, issuer identification, advertised scopes, and future tool step-up; custom-connector applicability requires live verification.
- [Claude.ai connector authentication](https://www.claude.com/docs/connectors/building/authentication) — CIMD selection, DCR fallback, callback, S256, refresh behavior, egress range, PRM `resource` matching, and Claude Code's loopback client.
- [ChatGPT client metadata document](https://chatgpt.com/oauth/client.json) and [Claude.ai client metadata document](https://claude.ai/oauth/mcp-oauth-client-metadata) — live verification fixtures.
