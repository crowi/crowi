---
"@crowi/api": patch
"@crowi/web": patch
"@crowi/api-contract": patch
---

Cancelling the OAuth consent screen no longer redirects to an unregistered redirect URI; the server now validates the redirect URI and builds the access_denied redirect, and the screen shows an error instead of navigating when the request is invalid.
