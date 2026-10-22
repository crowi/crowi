---
"@crowi/api": patch
---

Temporary passwords issued by an admin password reset and by user invitation are now generated from `crypto.randomInt` instead of `Math.random()`, which is not cryptographically secure — its internal state can be recovered from a handful of observed outputs, making later "random" values predictable. Both call sites now share one generator, so a compromised generator can no longer be fixed in one place while leaving the other exposed. The character set (uppercase/lowercase letters, digits, `!=-_`) and the 12-character minimum length are unchanged; the invitation path, which previously produced a shorter value, is now at least as long as the admin-reset path. No change to password hashing, legacy compatibility, or any user-facing flow.
