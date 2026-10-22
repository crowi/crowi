---
'@crowi/api': patch
'@crowi/web': patch
---

Fix an unthrottled reconnect loop against `GET /notifications/token` that occurred whenever `WS_TOKEN_SECRET` was left unset (a supported single-instance configuration): the server now reuses one random fallback signing secret per process instead of minting a new one on every call, and the browser now applies capped exponential backoff to repeated invalid-token WebSocket closes as a defense-in-depth safeguard against the same failure mode in other configurations (e.g. a `WS_TOKEN_SECRET` mismatch across instances).
