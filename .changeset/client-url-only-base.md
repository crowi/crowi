---
"@crowi/api": minor
---

Resolve the public origin from CLIENT_URL only.

`getBaseUrl()` — used to build absolute URLs in emails (invite /
activation / password reset / email-change) and for CORS — now reads the
`CLIENT_URL` env exclusively. The dead `app:url` config key and the
`BASE_URL` fallback are removed (Slack notification URLs switch to the
same source). The base is deliberately never derived from the request
Host/Origin (host-header injection would poison reset/activation links).
When `CLIENT_URL` is unset, the server warns at boot that email links
will be relative.
