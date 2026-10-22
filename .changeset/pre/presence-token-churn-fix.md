---
'@crowi/web': patch
---

Stop the presence WebSocket from reconnecting every ~4.5 minutes. The presence token is a handshake-only credential — the server never re-verifies it once a connection is established — so the old proactive `refetchInterval` that re-minted it before every expiry only tore the live socket down and re-broadcast the viewer list to every viewer of the page, for no auth benefit. The token query now holds a single token for the connection's whole life (matching the collab editor's token hook), and recovery from a genuinely expired token (a 4401 close) goes through an explicit token invalidate with capped exponential backoff instead of the removed timer.
