---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/plugin-api": minor
"@crowi/plugin-google": minor
"@crowi/web": minor
---

Add sign-in with Google, as a plugin (RFC-0014). Enable `@crowi/plugin-google` in your runner project, paste a Client ID and secret into the admin plugin screen, and a "Sign in with Google" button appears on the sign-in page without a restart. A first-time federated sign-in picks a username before an account is created, and then follows the instance's registration mode — active immediately when registration is Open, queued for administrator approval when Restricted, refused when Closed. Signed-in users can connect and disconnect providers from Settings, and an unlink is refused when it would leave the account with no way to sign back in. Google gets no special treatment in core: the whole flow (provider list / start / callback / handoff, signed state cookies, PKCE, OIDC verification) is generic, backed by a new auth-driver plugin SDK and a `UserIdentity` linking model, so any other OIDC provider can be added the same way. An email address is honoured only when the provider asserts it is verified, and one that matches an existing local account is never auto-linked — that sign-in is refused, and linking has to be done deliberately from Settings. Requires `AUTH_PUBLIC_WEB_URL` (or `CLIENT_URL`) to be set; see the "Signing in with an external account" operations guide for setup.
