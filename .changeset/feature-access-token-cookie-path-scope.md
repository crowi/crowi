---
"@crowi/web": patch
---

Security fix: the `crowi.accessToken` mirror cookie — written so headerless `<img src="/api/attachments/...">` requests can authenticate without an `Authorization` header — is now scoped to `path=/api/attachments` instead of `path=/`. Previously the browser attached this cookie to every same-origin request (pages, admin, every other API route); now it is only sent to the three attachment-delivery routes it exists for.

`storeTokens` and `clearTokens` also explicitly expire any pre-existing `path=/` cookie from a prior deploy, so upgrading clients don't retain a stray root-scoped copy of the token across login, silent refresh, or logout.
