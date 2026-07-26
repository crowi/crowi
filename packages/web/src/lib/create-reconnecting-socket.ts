/**
 * Shared reconnect-machine primitive for the WebSocket namespaces that hand-
 * rolled their own copy of the same skeleton (`use-presence.ts`,
 * `use-notifications-socket.ts`): a `reconnectAttempts` counter driving a
 * capped exponential backoff, a "reset the backoff only once a real message
 * has been parsed" trick, a close-code-driven policy for whether/how to
 * retry, and 4-handler teardown before `close()`. `collab` (Hocuspocus) is
 * out of scope — that library manages its own reconnects.
 *
 * A plain function, not a React hook: `usePresence` / `useNotificationsSocket`
 * already own their `useEffect`-scoped connect/teardown lifecycle (token
 * fetch, heartbeat, anti-flicker state, etc.), so wrapping this in a second
 * hook would mean managing two nested effects for one logical connection.
 * Call sites create one instance per `useEffect` run, call `.start()` at the
 * end of the effect body, and `.stop()` in the cleanup — the same shape as
 * today's `connect()` closure + cleanup function, just with the reconnect
 * machinery extracted.
 *
 * Channel-specific concerns stay OUT of this primitive on purpose:
 *   - heartbeats, anti-flicker admission delay, per-frame callbacks
 *     (`onPageUpdated` etc.) — `usePresence` owns these via `onOpen` /
 *     `onMessage`.
 *   - connection-state UI (`usePresence`'s `'connecting' | 'connected' |
 *     'error'`) — driven by `onConnecting` / `onOpen` / `onCloseCode`.
 *   - "first vs. Nth close of this kind" bookkeeping, and any side effect a
 *     caller wants to hang off a particular close code — that state lives in
 *     the caller's `onCloseCode`, which returns only the resulting retry
 *     policy. (`use-notifications-socket.ts` is the worked example: its
 *     module doc explains the token-mint recovery it drives from there.)
 */

/** WebSocket reconnect backoff after an unclean close, capped — the default
 * for every caller ({@link use-presence.ts} / {@link use-notifications-socket.ts}
 * both used this exact 1s/15s pair independently before). */
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 15_000;

/**
 * Capped exponential backoff delay (ms) for the nth (0-indexed) consecutive
 * retry attempt. Exported so a caller pacing a companion schedule OUTSIDE
 * this primitive (a retry of some other call that should stay in step with
 * the socket's own) gets the identical delay from the identical defaults,
 * rather than re-deriving the formula from matching literals.
 */
export function backoffDelayMs(attempt: number, baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

/**
 * What to do once a close's `code` has been classified by
 * {@link ReconnectingSocketOptions.onCloseCode}:
 *
 *   - `'stop'` — give up. No further reconnect is scheduled; recovery (if
 *     any) is entirely the caller's responsibility (e.g. presence waits for
 *     a fresh token to re-run its `useEffect` from scratch).
 *   - `'reconnect'` — retry immediately: no backoff delay, and the internal
 *     attempt counter resets to 0 (this close doesn't count as a failure).
 *   - `'backoff-retry'` — retry after the standard capped exponential
 *     backoff, incrementing the attempt counter. This is also what an
 *     unrecognised/ordinary unclean close (e.g. 1006) should return — it is
 *     the same schedule the pre-extraction code applied unconditionally to
 *     every non-special close code.
 */
export type CloseCodePolicy = 'stop' | 'reconnect' | 'backoff-retry';

export interface ReconnectingSocketOptions {
  /** Builds the URL for the next connection attempt. Called once per attempt
   * (initial connect and every reconnect), so a caller whose URL depends on
   * a token that can be refreshed out-of-band (a ref updated elsewhere) sees
   * that refresh on the next attempt this primitive itself initiates. */
  buildUrl: () => string;
  /**
   * Handles one inbound frame. `data` is already narrowed to `string` (a
   * binary frame is ignored — every consumer here speaks JSON text). Return
   * `'reset-backoff'` when `data` was a valid, recognised message — this is
   * the "reset on first *parsed* message, not on `onopen`" trick both
   * source hooks relied on: the transport handshake can complete right
   * before the server rejects the session (e.g. an expired token), and
   * resetting on `onopen` would pin the backoff at its floor forever in
   * that loop. Returning `void` (or nothing) leaves the backoff counter
   * untouched.
   */
  onMessage: (data: string) => 'reset-backoff' | void;
  /** Classifies a close `code` into a retry policy — see {@link CloseCodePolicy}. */
  onCloseCode: (code: number) => CloseCodePolicy;
  /**
   * Fires synchronously right before EVERY connection attempt — the
   * initial `start()` call and every reconnect this primitive itself
   * schedules (both the immediate `'reconnect'` retry and every
   * `'backoff-retry'` one), right before the underlying `WebSocket` is
   * constructed. Optional — a caller with connection-state UI (e.g.
   * `usePresence`'s `status: 'connecting'`) uses this to flip back to
   * "connecting" for each attempt; the pre-extraction hooks did the
   * equivalent at the top of their own `connect()` closure.
   */
  onConnecting?: () => void;
  /** Fires when the transport handshake completes. Optional — most
   * channel-specific setup (heartbeats, catch-up invalidation) hangs off
   * this. */
  onOpen?: () => void;
  /**
   * Fires synchronously right after a retry has been SCHEDULED — i.e.
   * right after `reconnectTimer` is set, for both the immediate
   * `'reconnect'` retry (`delayMs: 0`) and a capped `'backoff-retry'`
   * one. Does NOT fire for `'stop'` (no retry is ever scheduled for that
   * close). Optional — a caller with a `connecting | reconnecting |
   * connected | error`-shaped status derives `'reconnecting'` from this:
   * "the socket is down, but a retry attempt IS scheduled", as opposed
   * to a `'stop'` close, which the caller treats as terminal `'error'`.
   * Kept here (rather than re-derived from `onCloseCode`'s own return
   * value at each call site) because this primitive already owns
   * `reconnectTimer` and is the single source of truth for whether a
   * retry was actually scheduled.
   */
  onScheduledRetry?: (delayMs: number) => void;
  /** Backoff floor in ms. Default 1000 (1s). */
  backoffBaseMs?: number;
  /** Backoff ceiling in ms. Default 15000 (15s). */
  backoffMaxMs?: number;
}

export interface ReconnectingSocket {
  /** Open the first connection. Idempotent while already started. */
  start(): void;
  /** Tear down: null out the 4 handlers (so the close this triggers can
   * never itself schedule a reconnect), close the live socket, and cancel
   * any pending reconnect timer. Idempotent — safe to call from a `useEffect`
   * cleanup even if `start()` was never called. */
  stop(): void;
  /**
   * Send a text frame over the current connection. A thin, safe wrapper
   * around the underlying `WebSocket.send` — this primitive is the sole
   * owner of the live socket reference, so a caller that needs to push a
   * frame (e.g. presence's heartbeat) has no other way to reach it.
   * No-ops (returns `false`) when there is no connection or it isn't
   * `OPEN` yet, instead of throwing like a raw `WebSocket.send` would.
   */
  send(data: string): boolean;
}

/**
 * Create one reconnecting-WebSocket state machine. See the module doc for
 * the intended call shape (one instance per connect `useEffect` run).
 */
export function createReconnectingSocket(options: ReconnectingSocketOptions): ReconnectingSocket {
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  // Starts "stopped" so a `stop()` call before the first `start()` is a
  // harmless no-op, and a stray timer/handler firing after `stop()` (a
  // race between an in-flight event and the teardown) is ignored.
  let disposed = true;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const connect = () => {
    if (disposed) return;
    options.onConnecting?.();

    const ws = new WebSocket(options.buildUrl());
    socket = ws;

    ws.onopen = () => {
      if (disposed) return;
      options.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (disposed || typeof event.data !== 'string') return;
      const result = options.onMessage(event.data);
      if (result === 'reset-backoff') {
        reconnectAttempts = 0;
      }
    };

    ws.onerror = () => {
      // `onclose` always follows `onerror`; teardown/reconnect decisions
      // happen there so they run exactly once per failed connection.
    };

    ws.onclose = (event) => {
      if (disposed) return;
      const policy = options.onCloseCode(event.code);
      if (policy === 'stop') return;
      if (policy === 'reconnect') {
        reconnectAttempts = 0;
        reconnectTimer = setTimeout(connect, 0);
        options.onScheduledRetry?.(0);
        return;
      }
      // 'backoff-retry' — capped exponential backoff, same formula every
      // source hook computed independently.
      const delay = backoffDelayMs(reconnectAttempts, backoffBaseMs, backoffMaxMs);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(connect, delay);
      options.onScheduledRetry?.(delay);
    };
  };

  return {
    start() {
      if (!disposed) return;
      disposed = false;
      reconnectAttempts = 0;
      connect();
    },
    stop() {
      if (disposed) return;
      disposed = true;
      if (socket) {
        // Drop the lifecycle handlers before close so the teardown close
        // itself can never trigger onCloseCode / a reconnect.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      clearReconnectTimer();
    },
    send(data) {
      if (disposed || !socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(data);
      return true;
    },
  };
}
