---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Add more transactional emails on the shared HTML design system.

- **Test mail** is now the branded HTML template (was plain text), so the
  admin can verify the real look from `/admin/mail`.
- **Password-changed notification**: a security notice is sent to the
  account when its password is changed (self-service reset or `/me`
  password change).
- **Admin approval-pending notification**: under restricted registration,
  every active admin is emailed when a user self-registers and awaits
  approval.
- **Email-change confirmation**: changing your email via `/me` no longer
  applies immediately — a confirmation link is sent to the new address and
  the change is applied only after clicking it (`/confirm-email?token=…`),
  preventing typo / hijack via an unverified address.

All four reuse the localized (en / ja) MJML templates and the mail-token
scheme (new `email-change` purpose).
