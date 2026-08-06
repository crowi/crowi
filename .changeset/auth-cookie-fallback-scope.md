---
"@crowi/api": major
"@crowi/web": minor
---

Close the auth cookie-fallback gap RFC-0019 §7.5 flagged and scope `/mcp` to Personal Access Tokens only, so a JSON-RPC API and non-attachment routes can no longer be reached with just an ambient browser cookie.

BREAKING (`@crowi/api`): `createJwtAuth`'s cookie fallback (the `crowi.accessToken` cookie, previously accepted whenever the `Authorization` header was missing OR unparseable) is now header-only for every consumer except attachment delivery — admin, `/pages/*`, `/auth/me`, `/auth/logout`, the protected `/oauth/*` routes, `/search`, and every plugin route registered with the default `auth: 'user'` tier. A request that used to succeed via a stray or forged `crowi.accessToken` cookie with no (or a malformed) `Authorization` header now gets a `401 AUTHENTICATION_REQUIRED`; a normal browser session, which always sends the header from `localStorage`, is unaffected.

BREAKING (`@crowi/api`): the `crowi.accessToken` cookie fallback is now accepted ONLY on `GET`/`HEAD` for the three headerless attachment delivery routes — `/attachments/:id`, `/attachments/:id/original`, and `/attachments/by-key/*` (plus the `/files/:id` redirect target) — matching exactly the `<img src>` / direct-navigation shape the cookie exists for. Every other attachment route (upload, meta, delete, add) now requires the header.

BREAKING (`@crowi/api`): `/mcp` is now Personal Access Token (PAT) only. A web-session Bearer token, the `crowi.accessToken` cookie, and an OAuth access token (`oauth_access`) are all rejected with a JSON-RPC `401` — MCP previously rode the same shared auth as the rest of the API and accepted any of those. This is a deliberate defense-in-depth narrowing ahead of RFC-0022's resource/audience-bound OAuth support; once that lands, a properly scoped `oauth_access` token will be accepted again.

`@crowi/web`'s `apiFetch`, `useAddAttachment`, and the editor's paste/drag-and-drop upload no longer send a request with no `Authorization` header when the access token is missing — they recover it through the existing refresh flow first, and fail closed (the existing session-expired handling) instead of depending on the ambient cookie a normal page load already sends.
