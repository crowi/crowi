import type { onDisconnectPayload } from '@hocuspocus/server';
import type { CollabContext } from '../types';
import type { PresenceHooks } from '../presence';
import { wrapOnAuthenticateWithPresence, wrapOnDisconnectWithPresence } from '../presence-wiring';

/**
 * RFC-0005 Phase 1 — collab → presence wiring.
 *
 * `createCollabServer` wraps its `onAuthenticate` / `onDisconnect`
 * hooks so a collab connect fires `presence.markEditing` and a
 * disconnect fires `presence.unmarkEditing` (the page-presence `✏️`
 * editing badge). The wrapping logic is unit-tested here directly —
 * `server.ts` itself can't be imported under Jest (`@hocuspocus/server`
 * pulls in `crossws`'s ESM-only bundle), which is exactly why the
 * wrappers were extracted into the import-light `presence-wiring.ts`.
 */

interface PresenceCall {
  method: 'markEditing' | 'unmarkEditing';
  pageId: string;
  userId: string;
}

/** Recording presence adapter — logs every call for assertion. */
function makeRecordingPresence(): PresenceHooks & { calls: PresenceCall[] } {
  const calls: PresenceCall[] = [];
  return {
    calls,
    async markEditing(pageId, userId) {
      calls.push({ method: 'markEditing', pageId, userId });
    },
    async unmarkEditing(pageId, userId) {
      calls.push({ method: 'unmarkEditing', pageId, userId });
    },
  };
}

const PAGE = 'pageabc';
const USER = 'useracb';

/** Minimal onDisconnect payload — only `context` is read by the wrapper. */
const disconnectPayload = (context: Partial<CollabContext> | undefined) => ({ context }) as unknown as onDisconnectPayload<CollabContext>;

describe('collab → presence wiring (RFC-0005 Phase 1)', () => {
  test('onAuthenticate wrapper fires presence.markEditing with the resolved context', async () => {
    const presence = makeRecordingPresence();
    const base = async (): Promise<CollabContext> => ({ pageId: PAGE, userId: USER, readonly: false });

    const wrapped = wrapOnAuthenticateWithPresence(base, presence);
    const ctx = await wrapped({});
    // Fire-and-forget — let the swallowed promise settle.
    await new Promise((r) => setImmediate(r));

    expect(ctx).toEqual({ pageId: PAGE, userId: USER, readonly: false });
    expect(presence.calls).toEqual([{ method: 'markEditing', pageId: PAGE, userId: USER }]);
  });

  test('onDisconnect wrapper fires presence.unmarkEditing with the context page/user', async () => {
    const presence = makeRecordingPresence();
    const base = async (): Promise<void> => undefined;

    const wrapped = wrapOnDisconnectWithPresence(base, presence);
    await wrapped(disconnectPayload({ pageId: PAGE, userId: USER, readonly: false }));
    await new Promise((r) => setImmediate(r));

    expect(presence.calls).toEqual([{ method: 'unmarkEditing', pageId: PAGE, userId: USER }]);
  });

  test('onDisconnect wrapper skips unmarkEditing when the connection never authenticated', async () => {
    const presence = makeRecordingPresence();
    const base = async (): Promise<void> => undefined;

    const wrapped = wrapOnDisconnectWithPresence(base, presence);
    // No context (auth never completed) — nothing to unmark.
    await wrapped(disconnectPayload(undefined));
    await new Promise((r) => setImmediate(r));

    expect(presence.calls).toHaveLength(0);
  });

  test('the base onDisconnect still runs even though presence is wrapped around it', async () => {
    const presence = makeRecordingPresence();
    let baseRan = false;
    const base = async (): Promise<void> => {
      baseRan = true;
    };

    const wrapped = wrapOnDisconnectWithPresence(base, presence);
    await wrapped(disconnectPayload({ pageId: PAGE, userId: USER, readonly: false }));

    expect(baseRan).toBe(true);
  });

  test('a presence adapter that throws does not break the collab connection', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwingPresence: PresenceHooks = {
      async markEditing() {
        throw new Error('redis down');
      },
      async unmarkEditing() {
        throw new Error('redis down');
      },
    };
    const base = async (): Promise<CollabContext> => ({ pageId: PAGE, userId: USER, readonly: false });

    const wrapped = wrapOnAuthenticateWithPresence(base, throwingPresence);
    // The wrapper must still resolve the context despite the presence
    // failure (fire-and-forget, error swallowed + warn-logged).
    const ctx = await wrapped({});
    await new Promise((r) => setImmediate(r));

    expect(ctx).toMatchObject({ pageId: PAGE });
    warnSpy.mockRestore();
  });

  test('wrappers fall back to a no-op presence when none is injected', async () => {
    const base = async (): Promise<CollabContext> => ({ pageId: PAGE, userId: USER, readonly: false });
    // No presence arg — must not throw.
    const wrapped = wrapOnAuthenticateWithPresence(base);
    await expect(wrapped({})).resolves.toMatchObject({ pageId: PAGE });
  });
});
