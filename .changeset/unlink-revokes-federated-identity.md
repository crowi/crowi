---
"@crowi/api": patch
---

Fix disconnecting a linked provider account not actually revoking it. The registration journal entry for the provider account outlived the link, and the sign-in flow treated it as an interrupted registration to resume — so signing in again with the same provider account led back to the registration screen and, on submit, straight into the original account with the link restored, skipping the registration-mode and existing-email checks. Disconnecting now clears that entry, so a later sign-in with the same provider account is treated as a new registration and refused when the address already belongs to an account.
