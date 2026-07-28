---
'@crowi/api': patch
---

Harden the password-reset paths against sessions and links that outlive the reset. An administrator resetting someone's password from the admin screen now also signs that account out of every existing login session and invalidates any password-reset link still in flight for it, so the action taken in response to a suspected account takeover actually evicts the intruder (personal access tokens and OAuth-connected apps are unaffected, as with a self-service password change). In addition, a password-reset link now stops working if the account's email address changed after the link was sent — whoever still controls the old mailbox can no longer set the password of an account that has moved on; request a fresh link instead.
