---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Add self-service password reset.

Users who forget their password can now request a reset link from the
sign-in page. `POST /auth/forgot-password` emails a signed, 1-hour reset
link (always returns 200 to avoid revealing whether an email is
registered); the public `/reset-password?token=…` page sets the new
password via `POST /auth/reset-password` and signs the user in. The reset
email reuses the localized MJML template (en / ja).
