/**
 * Shared WebSocket close-code constants for every realtime namespace that
 * gates its upgrade on a short-lived signed token (`/presence`,
 * `/notifications`, and any future namespace built on the same pattern —
 * `collab` mints its own wsToken but currently closes only via
 * Hocuspocus's own lifecycle, not these codes).
 *
 * Both server attach handlers (`presence/attach.ts`, `notifications/attach.ts`)
 * and both client reconnect consumers (`use-presence.ts`,
 * `use-notifications-socket.ts`, via `create-reconnecting-socket.ts`) import
 * this single source instead of re-declaring the numeric values locally —
 * before this, the same three codes were hand-copied in four places with no
 * guarantee the wire contract stayed in sync.
 *
 *   - `INVALID_TOKEN` (4401) — the token is missing, malformed, expired, or
 *     fails signature verification. A reconnect with the *same* token would
 *     just be rejected again; the client needs a fresh token.
 *   - `FORBIDDEN` (4403) — the token verified, but the caller no longer has
 *     the access the channel requires (e.g. a revoked page read grant).
 *     Retrying is futile until the grant is restored.
 *   - `SHUTDOWN` (1001) — the standard "going away" code, sent when the
 *     server process is shutting down and asks connected clients to leave
 *     politely.
 *
 * 4401 / 4403 sit in the 4000-4999 WebSocket close-code range reserved for
 * private/application use (RFC 6455 §7.4.2); 1001 is a standard code.
 *
 * The two application-private codes are given channel-agnostic names here;
 * each caller re-exposes a locally meaningful alias where the generic name
 * would read oddly (e.g. presence's grant-based rejection reads better as
 * `NO_ACCESS` than `FORBIDDEN`) — see the call sites for the destructuring
 * pattern.
 */
export const WS_CLOSE_CODES = {
  INVALID_TOKEN: 4401,
  FORBIDDEN: 4403,
  SHUTDOWN: 1001,
} as const;

export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES];
