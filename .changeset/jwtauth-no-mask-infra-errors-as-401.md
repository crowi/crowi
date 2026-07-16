---
"@crowi/api": patch
---

Stop the JWT auth middleware from masking infrastructure and handler errors as a spurious `401 AUTHENTICATION_REQUIRED`. `jwtAuth` previously wrapped the principal lookup (`User.findById`), scope application (a PAT's best-effort last-used write), and the downstream handler call in a `try/catch` that turned any thrown error into a 401. A transient database failure during authentication therefore reached the client as "authentication required" (prompting a pointless re-login) and disappeared from server error logs. Such throws now propagate to the app error handler and surface as `500 INTERNAL_ERROR`; genuine authentication failures (missing/invalid/expired token, unknown user, inactive account) still return `401`/`403` unchanged, and the boundary stays fail-closed (a throw short-circuits before the handler runs). The admin-route composition (`createJwtAdminRequired`) preserves its short-circuit forwarding.
