---
'@crowi/api': patch
'@crowi/api-contract': patch
---

Requesting an email address change now cancels any earlier change still awaiting confirmation, and a confirmation link no longer works while the account is suspended. Previously the only way a pending change stopped being confirmable was the address actually changing or the requesting session being revoked — so a change requested from a stolen session could not be called off by asking for a different address, and suspending an account did not stop a link issued beforehand from moving the address that account recovers through.
