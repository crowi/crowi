import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconnectingSocket } from './create-reconnecting-socket';

/**
 * Minimal fake WebSocket — mirrors the harness `use-presence.test.ts` /
 * `use-notifications-socket.test.tsx` use to drive `onopen` / `onmessage` /
 * `onclose` explicitly, without a real network socket.
 */
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(payload);
  }

  // Test helpers.
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
  fail(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createReconnectingSocket', () => {
  it('does not open a connection until start() is called', () => {
    createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'stop',
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('opens a connection to buildUrl() on start() and fires onOpen', () => {
    const onOpen = vi.fn();
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket?x=1',
      onMessage: () => undefined,
      onCloseCode: () => 'stop',
      onOpen,
    });

    rs.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://example.test/socket?x=1');
    expect(onOpen).not.toHaveBeenCalled();

    FakeWebSocket.instances[0].open();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent — calling it twice does not open a second connection', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'stop',
    });

    rs.start();
    rs.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('ignores non-string frames and passes string frames to onMessage', () => {
    const onMessage = vi.fn();
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage,
      onCloseCode: () => 'stop',
    });
    rs.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.emit(new ArrayBuffer(4));
    expect(onMessage).not.toHaveBeenCalled();

    ws.emit('hello');
    expect(onMessage).toHaveBeenCalledWith('hello');
  });

  it("'stop' policy: no reconnect is scheduled after close", () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'stop',
    });
    rs.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(4401);

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("'reconnect' policy: retries immediately (no backoff delay)", () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'reconnect',
    });
    rs.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(4401);

    // A 0ms-scheduled reconnect fires on the very next timer tick.
    vi.advanceTimersByTime(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("'reconnect' policy resets the attempt counter to 0 — a subsequent 'backoff-retry' starts back at the base delay", () => {
    let policy: 'reconnect' | 'backoff-retry' = 'reconnect';
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => policy,
      backoffBaseMs: 1_000,
      backoffMaxMs: 15_000,
    });
    rs.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(4401); // 'reconnect' — resets attempts, immediate retry.
    vi.advanceTimersByTime(0);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Switch to 'backoff-retry' for the next close — if the attempt
    // counter had NOT been reset by the previous 'reconnect', this would
    // schedule at 2s (2^1 * base) instead of the 1s floor.
    policy = 'backoff-retry';
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].fail(1006);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("'backoff-retry' policy: capped exponential backoff, growing on each consecutive failure", () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
      backoffBaseMs: 1_000,
      backoffMaxMs: 15_000,
    });
    rs.start();

    // Attempt 0 -> 1s.
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Attempt 1 -> 2s.
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].fail(1006);
    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Attempt 2 -> 4s.
    FakeWebSocket.instances[2].open();
    FakeWebSocket.instances[2].fail(1006);
    vi.advanceTimersByTime(3_999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('caps the backoff delay at backoffMaxMs', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
      backoffBaseMs: 1_000,
      backoffMaxMs: 3_000,
    });
    rs.start();

    // Attempt 0 -> 1s, attempt 1 -> 2s, attempt 2 -> would be 4s uncapped,
    // but the ceiling caps it at 3s.
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].fail(1006);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2].open();
    FakeWebSocket.instances[2].fail(1006);
    vi.advanceTimersByTime(2_999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('resets the backoff to the base delay once onMessage returns reset-backoff (reset-on-first-parsed-message)', () => {
    let shouldReset = false;
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => (shouldReset ? 'reset-backoff' : undefined),
      onCloseCode: () => 'backoff-retry',
      backoffBaseMs: 1_000,
      backoffMaxMs: 15_000,
    });
    rs.start();

    // Fail twice without ever parsing a message — backoff grows to attempt 2 (4s).
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].fail(1006);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // This time a message that resets the backoff arrives before the
    // next close — the FOLLOWING reconnect must be back at the 1s floor,
    // not escalated to 8s.
    FakeWebSocket.instances[2].open();
    shouldReset = true;
    FakeWebSocket.instances[2].emit('{"type":"ok"}');
    FakeWebSocket.instances[2].fail(1006);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('a non-resetting message does not reset the backoff', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
      backoffBaseMs: 1_000,
      backoffMaxMs: 15_000,
    });
    rs.start();

    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // A message arrives but onMessage does not signal 'reset-backoff' —
    // the NEXT reconnect must still be at the escalated 2s delay.
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].emit('unparsed');
    FakeWebSocket.instances[1].fail(1006);

    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('stop() nulls the 4 handlers before closing, so the teardown close never triggers onCloseCode / a reconnect', () => {
    const onCloseCode = vi.fn(() => 'backoff-retry' as const);
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode,
    });
    rs.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    onCloseCode.mockClear();

    rs.stop();
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();

    // Simulate the underlying close event firing anyway (the real
    // WebSocket API would not, since the handler was nulled — but this
    // guards the primitive's OWN internal `disposed` check too).
    ws.onclose = null;
    expect(onCloseCode).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stop() nulls handlers and closes the socket BEFORE clearing the pending reconnect timer', () => {
    const order: string[] = [];
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
    });
    rs.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.fail(1006); // schedules a pending backoff-retry timer

    ws.close.mockImplementation(() => {
      order.push('close');
    });
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => {
      order.push('clearTimeout');
    });

    rs.stop();
    expect(order).toEqual(['close', 'clearTimeout']);
    clearTimeoutSpy.mockRestore();
  });

  it('stop() cancels a pending backoff-scheduled reconnect timer', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
    });
    rs.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);

    rs.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stop() before start() is a harmless no-op', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'stop',
    });
    expect(() => rs.stop()).not.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('start() after stop() opens a fresh connection with attempts reset', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
      backoffBaseMs: 1_000,
      backoffMaxMs: 15_000,
    });
    rs.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].fail(1006);
    // Escalated to attempt 1 (2s) — do not let it fire.
    rs.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // A fresh start() opens instance #3 directly — no leftover backoff.
    rs.start();
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].open();
    FakeWebSocket.instances[2].fail(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  describe('send', () => {
    it('forwards data and returns true when the socket is OPEN', () => {
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'stop',
      });
      rs.start();
      const ws = FakeWebSocket.instances[0];
      ws.open();

      expect(rs.send('hello')).toBe(true);
      expect(ws.sent).toEqual(['hello']);
    });

    it('returns false and does not throw before the socket has opened', () => {
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'stop',
      });
      rs.start();

      expect(rs.send('too early')).toBe(false);
      expect(FakeWebSocket.instances[0].sent).toEqual([]);
    });

    it('returns false when there is no live connection at all', () => {
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'stop',
      });
      expect(rs.send('never started')).toBe(false);
    });

    it('returns false after stop()', () => {
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'stop',
      });
      rs.start();
      FakeWebSocket.instances[0].open();
      rs.stop();
      expect(rs.send('after stop')).toBe(false);
    });
  });

  describe('onConnecting', () => {
    it('fires once, right before the underlying WebSocket is constructed, on start()', () => {
      const calls: string[] = [];
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'stop',
        onConnecting: () => calls.push('connecting'),
      });
      expect(calls).toEqual([]);
      rs.start();
      expect(calls).toEqual(['connecting']);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('fires again before an immediate reconnect() policy retry', () => {
      const calls: string[] = [];
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'reconnect',
        onConnecting: () => calls.push('connecting'),
      });
      rs.start();
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
      vi.advanceTimersByTime(0);
      expect(calls).toEqual(['connecting', 'connecting']);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('fires again before a backoff-retry policy retry, after the delay elapses (not at close time)', () => {
      const calls: string[] = [];
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'backoff-retry',
        backoffBaseMs: 1_000,
        backoffMaxMs: 15_000,
        onConnecting: () => calls.push('connecting'),
      });
      rs.start();
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(1006);
      expect(calls).toEqual(['connecting']);
      vi.advanceTimersByTime(999);
      expect(calls).toEqual(['connecting']);
      vi.advanceTimersByTime(1);
      expect(calls).toEqual(['connecting', 'connecting']);
    });

    it('does not fire for a stop() policy close, or after stop() has been called', () => {
      const calls: string[] = [];
      const rs = createReconnectingSocket({
        buildUrl: () => 'ws://example.test/socket',
        onMessage: () => undefined,
        onCloseCode: () => 'stop',
        onConnecting: () => calls.push('connecting'),
      });
      rs.start();
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].fail(4401);
      expect(calls).toEqual(['connecting']);

      rs.stop();
      calls.length = 0;
      vi.advanceTimersByTime(60_000);
      expect(calls).toEqual([]);
    });
  });

  it('uses the default 1s / 15s backoff bounds when not overridden', () => {
    const rs = createReconnectingSocket({
      buildUrl: () => 'ws://example.test/socket',
      onMessage: () => undefined,
      onCloseCode: () => 'backoff-retry',
    });
    rs.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].fail(1006);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
