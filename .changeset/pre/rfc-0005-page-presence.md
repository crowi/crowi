---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Page presence & header UI (RFC-0005) v2.0 is now available. A live presence row showing "who is viewing right now" in realtime was added to the page view, and the header meta row was restructured into unified clickable chips.

Main features:

- **Live presence row**: above the page title, shows realtime avatars of the users currently viewing the page. Anyone with the realtime co-editing editor open gets a `✏️` badge. Up to 5 avatars + a `[+N]` popover (20-item cap), with your own marked "(you)". The whole row is hidden when you're the only one; on narrow screens it collapses to a `[👁 N]` chip that expands into a sheet. New joins are smoothed in with a 3-second anti-flicker delay.
- **Restructured meta-chip row**: the static author / updated-time elements plus the four like / view / comment / backlink items are converted into unified `[icon][count][label]` clickable chips. Like and view open modals; comment and backlink smooth-scroll to the relevant section + focus its heading. count=0 is greyed out + non-interactive + tooltip. Pressing the like button optimistically updates the chip count (reverting via toast on failure).
- **"Who liked" modal**: a new modal shaped like the existing "who viewed" modal. The v1.x viewer avatar stack is removed and replaced by the view chip + modal.
- **Presence WebSocket / endpoints**: added `GET /api/pages/:id/presence-token` (short-lived JWT issuance) and a `/presence/:pageId` WebSocket. Like RFC-0003's `/collab`, the WebSocket attaches to the api process's `http.Server` in `ws noServer` mode, needing no separate process or port. Viewer state is a Redis hash and multi-instance propagation reuses the existing Redis via pub/sub (no dedicated infra). `isEditing` is computed by joining against RFC-0003's editor-cap Set at broadcast time.

The `@crowi/api-contract` minor bump is for the new endpoints (`GET /pages/:id/presence-token` / `GET /pages/:id/likers`) and the presence WebSocket message schema.

See `apps/crowi-site/content/docs/{ja,en}/guide/pages.mdx` for the user-facing guide, `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for the operator `/presence/*` reverse-proxy note, and `docs/rfcs/0005-page-presence.md` for the design rationale.
