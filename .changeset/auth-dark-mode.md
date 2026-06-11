---
"@crowi/web": patch
---

Fix dark mode on the pre-auth screens (login / register / reset-password /
installer). The selected segment of the theme and language toggles is a
near-white pill, but its label used `text-foreground`, which turns white in
dark mode and disappeared — it now uses a fixed dark colour. The animated
backdrop also gained a dark-mode gradient (same brand hues, deeply darkened)
so it no longer clashes with the dark auth card.
