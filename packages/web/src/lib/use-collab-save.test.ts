import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatelessListener } from './use-collab-document';
import { type CollabSaveSession, useCollabSave } from './use-collab-save';

/**
 * Build a session double whose `sendStateless` records outgoing
 * payloads in an `outbox` and whose `subscribeStateless` exposes the
 * single listener so the test can simulate inbound acks. We don't
 * spin up a real `HocuspocusProvider` because the hook only depends
 * on the narrow `CollabSaveSession` shape — keeping the test surface
 * minimal makes it easier to cover the 5-second timeout reliably.
 */
function makeSession() {
  const outbox: string[] = [];
  let listener: StatelessListener | null = null;
  const session: CollabSaveSession = {
    status: 'connected',
    readonly: false,
    sendStateless: vi.fn((payload: string) => {
      outbox.push(payload);
      return true;
    }),
    subscribeStateless: vi.fn((l: StatelessListener) => {
      listener = l;
      return () => {
        listener = null;
      };
    }),
  };
  return {
    session,
    outbox,
    simulate(payload: object) {
      if (!listener) throw new Error('no listener registered');
      listener(JSON.stringify(payload));
    },
    setStatus(status: CollabSaveSession['status']) {
      (session as { status: CollabSaveSession['status'] }).status = status;
    },
    setReadonly(readonly: boolean) {
      (session as { readonly: boolean }).readonly = readonly;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useCollabSave', () => {
  it('rejects with NOT_READY when session is null', async () => {
    const { result } = renderHook(() => useCollabSave(null));
    // `save()` flips the hook's saving state, so run it inside `act` to flush
    // that update — otherwise React warns it was "not wrapped in act".
    await act(async () => {
      await expect(result.current.save()).rejects.toMatchObject({ reason: 'NOT_READY' });
    });
  });

  it('rejects with READONLY when the session is read-only', async () => {
    const { session, setReadonly } = makeSession();
    setReadonly(true);
    const { result } = renderHook(() => useCollabSave(session));
    await act(async () => {
      await expect(result.current.save()).rejects.toMatchObject({ reason: 'READONLY' });
    });
  });

  it('rejects with NOT_READY when the session is not yet connected', async () => {
    const { session, setStatus } = makeSession();
    setStatus('connecting');
    const { result } = renderHook(() => useCollabSave(session));
    await act(async () => {
      await expect(result.current.save()).rejects.toMatchObject({ reason: 'NOT_READY' });
    });
  });

  it('emits a crowi:save stateless payload and resolves on crowi:save-ok', async () => {
    const helper = makeSession();
    const { result } = renderHook(() => useCollabSave(helper.session));

    let saveResult: Promise<{ revisionId: string; kind: string }> | undefined;
    act(() => {
      saveResult = result.current.save();
    });

    // The hook should have written exactly one stateless payload.
    expect(helper.outbox).toHaveLength(1);
    expect(JSON.parse(helper.outbox[0])).toEqual({ kind: 'crowi:save' });
    expect(result.current.isSaving).toBe(true);

    act(() => {
      helper.simulate({ kind: 'crowi:save-ok', revisionId: 'rev123' });
    });

    await expect(saveResult).resolves.toEqual({ kind: 'crowi:save-ok', revisionId: 'rev123' });
    expect(result.current.isSaving).toBe(false);
    expect(result.current.lastError).toBeNull();
  });

  it('rejects with the server error on crowi:save-error', async () => {
    const helper = makeSession();
    const { result } = renderHook(() => useCollabSave(helper.session));

    let saveResult: Promise<unknown> | undefined;
    act(() => {
      saveResult = result.current.save();
    });

    act(() => {
      helper.simulate({ kind: 'crowi:save-error', code: 'RENDERER_FAILED', message: 'pipeline crashed' });
    });

    await expect(saveResult).rejects.toMatchObject({
      reason: 'SERVER',
      code: 'RENDERER_FAILED',
      message: 'pipeline crashed',
    });

    // The rejection's `resolvePending` path also flushes `isSaving`
    // back to false and stores the failure in `lastError`. Reading
    // those flags right after the rejection settles is safe because
    // the promise resolution and the React setState calls happen in
    // the same microtask.
    expect(result.current.isSaving).toBe(false);
    expect(result.current.lastError?.code).toBe('RENDERER_FAILED');
  });

  it('rejects with TIMEOUT when no ack arrives in 5 seconds', async () => {
    const helper = makeSession();
    const { result } = renderHook(() => useCollabSave(helper.session));

    // Attach a `.catch` immediately so the promise is never observed
    // as "unhandled" by the runtime — `expect(...).rejects` resolves
    // asynchronously which leaves a window where the rejection is
    // floating, tripping vitest's unhandled-rejection reporter.
    let savePromise: Promise<unknown> | undefined;
    const errorPromise = new Promise<unknown>((resolve) => {
      act(() => {
        savePromise = result.current.save().catch(resolve);
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    const err = await errorPromise;
    expect(err).toMatchObject({ reason: 'TIMEOUT' });
    expect(result.current.isSaving).toBe(false);
    // Bind to the lint to acknowledge the variable is intentionally
    // unused after the catch handler claimed the rejection.
    expect(savePromise).toBeDefined();
  });

  it('rejects a concurrent save() with BUSY while another is pending', async () => {
    const helper = makeSession();
    const { result } = renderHook(() => useCollabSave(helper.session));

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current.save();
      second = result.current.save();
    });

    await expect(second).rejects.toMatchObject({ reason: 'BUSY' });

    // First save still in flight — wrap up so the test cleans up
    // properly without leaking a pending promise rejection.
    act(() => {
      helper.simulate({ kind: 'crowi:save-ok', revisionId: 'rev-z' });
    });
    await expect(first).resolves.toBeTruthy();
  });

  it('ignores foreign stateless messages (e.g. force-reload)', async () => {
    const helper = makeSession();
    const { result } = renderHook(() => useCollabSave(helper.session));

    let saveResult: Promise<unknown> | undefined;
    act(() => {
      saveResult = result.current.save();
    });

    // Force-reload arrives on the same channel — the save listener
    // must NOT claim it.
    act(() => {
      helper.simulate({ kind: 'crowi:force-reload', reason: 'admin-edit' });
    });
    expect(result.current.isSaving).toBe(true);

    // Now deliver the real ack.
    act(() => {
      helper.simulate({ kind: 'crowi:save-ok', revisionId: 'rev-mixed' });
    });
    await expect(saveResult).resolves.toMatchObject({ revisionId: 'rev-mixed' });
  });
});
