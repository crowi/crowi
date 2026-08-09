---
'@crowi/web': patch
---

Resolve every Radix primitive through the `radix-ui` meta package (upgraded to ^1.6.7) so the library is loaded exactly once. Two dialogs had already been patched individually for leaving the page unclickable after they closed; the actual cause was that `DismissableLayer` existed twice — once via `radix-ui`, once via a direct `@radix-ui/react-*` dependency — and each copy kept its own layer registry, so neither released the body `pointer-events` lock the other had taken. Any other overlay pair split across the two copies could have frozen the page the same way. An ESLint rule now rejects direct `@radix-ui/react-*` imports so the duplication cannot return, and an end-to-end test pins the menu-to-dialog handoff that was broken.
