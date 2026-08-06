---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

Add the server-side and screen-level foundation for Google federated sign-in (RFC-0014): the auth-driver plugin SDK (credential / OAuth2 / OIDC), a `UserIdentity` linking model, the OAuth2/OIDC provider list/start/callback/handoff flow with signed state cookies and PKCE, and a just-in-time registration screen that lets a first-time federated sign-in pick a username before an account is created. This groundwork is not yet reachable from the product UI — no sign-in button links to it yet, and linking/unlinking an existing account is not implemented — both land in a later phase of the same feature.
