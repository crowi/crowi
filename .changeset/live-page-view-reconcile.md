---
'@crowi/web': patch
---

Page viewing now self-heals when the live push channel misses an update: a viewer's tab going hidden then visible again, the presence socket reconnecting after a sleep/network drop, and a 3-minute background timer all trigger a reconcile against the server's current head, catching up on any save that happened while disconnected — the previous push-only sync could permanently miss updates made while a tab was backgrounded. A save made from another tab or device by the viewer themself now also swaps in silently (no banner) instead of never appearing, and losing read access while viewing a page now switches the view to the access-denied state automatically instead of leaving the protected content on screen.
