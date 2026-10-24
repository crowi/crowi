---
"@crowi/api": patch
"@crowi/web": patch
---

OAuth refresh tokens are now grouped by an immutable per-sign-in family id. Revoking an authorized app (or reuse detection) revokes every refresh token of that sign-in at once, including tokens that fell out of the rotation chain and tokens created by a refresh still in flight, without walking the rotation history. The authorized-apps list also gets a dedicated index. An already-issued access token stays valid until it expires (one hour by default).

Upgrade note: on boot, every existing refresh token without a family id is revoked, so existing OAuth clients such as the CLI must sign in once again after upgrading. Stop all old replicas before starting the new version.
