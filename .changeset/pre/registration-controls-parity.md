---
'@crowi/api': minor
---

Fix new-user registration controls to match the documented (legacy) behavior.

The registration email whitelist (`security:registrationWhiteList`) is now
enforced at sign-up time in every non-closed registration mode — previously the
new `/auth/register` endpoint ignored it, so a configured whitelist had no
effect on public registration (a regression from the legacy app). When the
whitelist is non-empty, only matching addresses can register; an empty
whitelist imposes no restriction.

The admin Security screen labels were also corrected to describe what each mode
actually does: Restricted = "admin approval required" (was mislabeled as
"whitelist only"), Closed = "invite only" (public sign-up disabled, admins can
still invite), and the whitelist is described as a cross-mode gate.
