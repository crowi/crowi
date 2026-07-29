---
"@crowi/web": minor
---

Rework live presence on narrow screens into a dedicated card, and stop treating a brief reconnect as "presence is gone".

Below 768px, "who is viewing this page right now" used to be a `[👁 N]` chip above the title — which sat awkwardly close to the historical `[👁 N] Seen` chip below the title, two different facts wearing the same icon and number. It is now a dedicated card placed directly under the statistics chips, so the mobile header reads title → author/updated → statistics → live presence → body. The card shows up to three overlapping avatars plus `+N`, a plain-language count that includes you ("5 viewing now" / 「5 人が現在閲覧中」), and a connection indicator that is readable from its text rather than colour alone. The whole card is one tap target opening the same viewer sheet as before, and the 60px compact header keeps a short `Live · N` trigger. Wide-viewport headers are unchanged.

The card also collapses away entirely when you are the only person present and expands smoothly when someone joins, compensating your scroll position so the body text never jumps while you are reading. On the connection side, the client now distinguishes an automatic reconnect that is still being retried from a connection that has terminally failed: during a retry the card stays put in a neutral "Reconnecting…" state showing the viewers it last knew about, instead of vanishing on every momentary network blip, and the green `Live` indicator only appears once viewer updates have actually arrived on the current connection.
