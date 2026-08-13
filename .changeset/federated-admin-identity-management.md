---
"@crowi/api": patch
"@crowi/api-contract": patch
"@crowi/web": patch
---

Admins can now see which users have a linked federated identity (RFC-0014) and disconnect one from the user list — the users table shows a linked-account icon per row, and a new row action unlinks a provider. If the target user has no password, the admin unlink issues a random one and shows it once (mirroring the existing password-reset flow); an existing password is left untouched. An admin can never unlink their own identity from this screen, and unlinking is refused instance-wide while password sign-in is disabled, since either would strand the account. The unlink removes the same registration-journal row the self-service unlink already cleans up, so the disconnected provider account cannot walk straight back into the account through the sign-in screen.

An account with a linked federated identity can no longer have its email address changed by an admin either: `PUT /admin/users/{id}/email` now refuses a different address with `409 EMAIL_LOCKED_BY_FEDERATED_IDENTITY`, the same way the self-service `PUT /me` already does. Unlinking the identity first is the only way to change it. The user-edit dialog no longer has an email field at all — `PATCH /admin/users/{id}` now updates only the display name, and email changes go exclusively through the dedicated "Change email" dialog, so there is exactly one email-writing path to lock.
