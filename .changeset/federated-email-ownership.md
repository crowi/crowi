---
"@crowi/api": patch
"@crowi/api-contract": patch
"@crowi/web": patch
---

An account with one or more linked federated identities (Google, or any other configured provider — RFC-0014) can no longer move its own email address through `PUT /me`. The address on a federated account was verified by the identity provider at sign-in; letting the holder of a stolen `profile:write` credential (a leaked personal access token or OAuth grant) redirect the confirmation link to an address they control would hand the account's recovery identifier away. A request that submits a different email now fails with `400 EMAIL_LOCKED_BY_FEDERATED_IDENTITY` and applies nothing from that request — name and language changes sent in the same request are not saved either, so the outcome is all-or-nothing. Resubmitting the current, unchanged address still saves name/language normally, and accounts with no linked identity are completely unaffected — the confirm-by-email flow behaves exactly as before.

The profile response (`GET /me` and `PUT /me`) now carries a `federated` boolean. The Profile tab uses it to disable the email field and show a note pointing to the Security tab, where the linked account can be reviewed or unlinked; this is a UX aid only; the server-side rule above is what actually enforces the lock.
