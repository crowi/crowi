---
'@crowi/api': patch
---

Close a way an attacker could undo an account recovery. A pending email-address change was confirmed purely on a link, so someone who requested a change to their own address while holding a stolen session could still complete it after an administrator reset the password — taking over the account's recovery address at the moment the administrator believed the problem was handled. Confirming an address change now requires the session that requested it to still be valid, so any action that signs the account out (an administrator reset, or the owner changing their own password) also cancels a change that is still pending. If your own change is cancelled this way, just request it again.
