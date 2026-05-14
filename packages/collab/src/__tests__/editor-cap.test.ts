// Pin WS_TOKEN_SECRET before the api util's resolveWsTokenSecret() fires;
// onAuthenticate verifies tokens against the same secret the smoke test
// uses.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import path from 'node:path';
import mongoose from 'mongoose';
import { startInMemoryMongo, type SmokeMongo } from './setup';
import { registerModels, type CollabModels } from '../models';
import { getWsTokenUtil, _resetWsTokenUtilCacheForTesting, type CollabWsTokenUtil } from '../ws-token';
import { createOnAuthenticate } from '../hooks/on-authenticate';
import { createOnDisconnect } from '../hooks/on-disconnect';
import type { EditorCapCounter } from '../editor-cap';

/**
 * Phase 6 editor cap defence (collab side). Drives the hooks directly
 * — same posture as the Phase 3 smoke test — so we avoid the
 * crossws/Jest CJS friction and keep assertions focused on the cap
 * logic (acquire / release / readonly skip / fail-open).
 *
 * The Hocuspocus WebSocket layer itself is covered by its own suite;
 * the contract we own here is "tryAcquire on auth, release on
 * disconnect, never SREM a readonly entry".
 */

const apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiWsToken = require(path.join(path.dirname(apiPkgPath), 'dist', 'util', 'ws-token.js')) as {
  createWsTokenUtil(): {
    signWsToken(claims: { userId: string; pageId: string; readonly: boolean }): { token: string; expiresAt: Date };
  };
};

interface CounterCall {
  method: 'tryAcquire' | 'release' | 'peek';
  pageId: string;
  userId?: string;
  socketId?: string;
}

/**
 * Build a recording counter so each test can configure return values
 * and assert call sequence. The shape mirrors the EditorCapCounter
 * interface, plus a `calls[]` log of every invocation.
 */
function makeRecordingCounter(
  opts: {
    peek?: (pageId: string) => { count: number; cap: number };
    tryAcquire?: (pageId: string, userId: string, socketId: string) => { acquired: boolean; count: number; cap: number };
  } = {},
): EditorCapCounter & { calls: CounterCall[] } {
  const calls: CounterCall[] = [];
  return {
    maxEditorsPerPage: 20,
    calls,
    async peek(pageId) {
      calls.push({ method: 'peek', pageId });
      return opts.peek?.(pageId) ?? { count: 0, cap: 20 };
    },
    async tryAcquire(pageId, userId, socketId) {
      calls.push({ method: 'tryAcquire', pageId, userId, socketId });
      return opts.tryAcquire?.(pageId, userId, socketId) ?? { acquired: true, count: 1, cap: 20 };
    },
    async release(pageId, userId, socketId) {
      calls.push({ method: 'release', pageId, userId, socketId });
    },
    async disconnect() {
      /* nothing */
    },
  };
}

const makeAuthPayload = (token: string, pageId: string, socketId = 'test-socket') =>
  ({
    documentName: pageId,
    token,
    requestParameters: new URLSearchParams(),
    requestHeaders: new Headers(),
    request: undefined as never,
    instance: undefined as never,
    socketId,
    connectionConfig: { readOnly: false, isAuthenticated: false },
    providerVersion: null,
    context: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const makeDisconnectPayload = (pageId: string, userId: string, socketId: string, readonly: boolean) =>
  ({
    clientsCount: 0,
    context: { pageId, userId, readonly },
    document: undefined as never,
    documentName: pageId,
    instance: undefined as never,
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('@crowi/collab Phase 6 editor cap defence', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let wsTokenUtil: CollabWsTokenUtil;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerModels();
    models = reg.models;
    _resetWsTokenUtilCacheForTesting();
    wsTokenUtil = getWsTokenUtil();
  });

  afterAll(async () => {
    await memMongo.stop();
  });

  /**
   * Seed a public page so onAuthenticate's `Page.findById` passes.
   * Returns the page id + a wsToken minted by the api util.
   */
  const seedPageAndToken = async (readonly: boolean) => {
    const userId = new mongoose.Types.ObjectId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.create({
      path: `/__collab-cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      creator: userId,
      grant: 1,
      status: 'published',
    });
    const pageId = page._id.toString();
    const apiUtil = apiWsToken.createWsTokenUtil();
    const { token } = apiUtil.signWsToken({ userId: userId.toString(), pageId, readonly });
    return { pageId, userId: userId.toString(), token };
  };

  test('21st client (peek says cap-reached) is promoted to readonly without invoking tryAcquire', async () => {
    // wsToken minted as editable, but the api-side peek says cap-reached
    // — onAuthenticate must respect the peek result and skip the SADD
    // attempt. (Same UX path the api handler would have taken if the
    // race lost in token issuance.)
    const { pageId, token } = await seedPageAndToken(false);
    const counter = makeRecordingCounter({
      tryAcquire: () => ({ acquired: false, count: 20, cap: 20 }),
    });

    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page: models.Page },
      // Force the cap-reached path through the cheaper of the two
      // checks (cap peek). Phase 6 OR's the two readonly bits.
      checkEditorCap: async () => ({ readonly: true }),
      editorCapCounter: counter,
    });

    const payload = makeAuthPayload(token, pageId);
    const ctx = await onAuthenticate(payload);
    expect(ctx.readonly).toBe(true);
    expect(payload.connectionConfig.readOnly).toBe(true);
    // readonly path must NOT call tryAcquire (no slot is taken).
    expect(counter.calls.some((c) => c.method === 'tryAcquire')).toBe(false);
  });

  test('tryAcquire race loss (acquired:false) promotes the connection to readonly', async () => {
    const { pageId, userId, token } = await seedPageAndToken(false);
    const counter = makeRecordingCounter({
      tryAcquire: () => ({ acquired: false, count: 20, cap: 20 }),
    });

    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page: models.Page },
      // peek-side OK (under cap) so we exercise the tryAcquire branch.
      checkEditorCap: async () => ({ readonly: false }),
      editorCapCounter: counter,
    });

    const payload = makeAuthPayload(token, pageId, 'sock-race');
    const ctx = await onAuthenticate(payload);
    expect(ctx).toMatchObject({ userId, pageId, readonly: true });
    expect(payload.connectionConfig.readOnly).toBe(true);
    expect(counter.calls.filter((c) => c.method === 'tryAcquire')).toEqual([{ method: 'tryAcquire', pageId, userId, socketId: 'sock-race' }]);
  });

  test('tryAcquire success: returns editable context and records page/user/socket', async () => {
    const { pageId, userId, token } = await seedPageAndToken(false);
    const counter = makeRecordingCounter({
      tryAcquire: () => ({ acquired: true, count: 5, cap: 20 }),
    });

    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page: models.Page },
      checkEditorCap: async () => ({ readonly: false }),
      editorCapCounter: counter,
    });

    const payload = makeAuthPayload(token, pageId, 'sock-ok');
    const ctx = await onAuthenticate(payload);
    expect(ctx).toEqual({ userId, pageId, readonly: false });
    expect(payload.connectionConfig.readOnly).toBe(false);
    expect(counter.calls).toEqual([{ method: 'tryAcquire', pageId, userId, socketId: 'sock-ok' }]);
  });

  test('onDisconnect releases the entry recorded at onAuthenticate', async () => {
    const counter = makeRecordingCounter();
    const onDisconnect = createOnDisconnect({ editorCapCounter: counter });

    await onDisconnect(makeDisconnectPayload('page-1', 'user-1', 'sock-1', false));

    expect(counter.calls).toEqual([{ method: 'release', pageId: 'page-1', userId: 'user-1', socketId: 'sock-1' }]);
  });

  test('onDisconnect on a readonly context does NOT release (no slot was taken)', async () => {
    const counter = makeRecordingCounter();
    const onDisconnect = createOnDisconnect({ editorCapCounter: counter });

    // readonly: true context — the SADD was skipped in onAuthenticate,
    // so SREM here would remove an unrelated user's entry on hash
    // collision. The hook must early-return.
    await onDisconnect(makeDisconnectPayload('page-2', 'user-2', 'sock-2', true));

    expect(counter.calls).toEqual([]);
  });

  test('onDisconnect without a context (auth-not-completed race) is a safe no-op', async () => {
    const counter = makeRecordingCounter();
    const onDisconnect = createOnDisconnect({ editorCapCounter: counter });

    await onDisconnect({
      clientsCount: 0,
      // missing context — simulates a socket that died mid-handshake
      context: undefined,
      document: undefined as never,
      documentName: 'page-3',
      instance: undefined as never,
      requestHeaders: new Headers(),
      requestParameters: new URLSearchParams(),
      socketId: 'sock-3',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(counter.calls).toEqual([]);
  });

  test('fail-open: with no counter injected, hooks use the no-op counter and never deny editable connections', async () => {
    // No `editorCapCounter` in deps → defaults to noopEditorCapCounter.
    // peek always = 0, tryAcquire always acquired:true, release always
    // a no-op. This is the single-instance dev posture (REDIS_URL
    // unset).
    const { pageId, userId, token } = await seedPageAndToken(false);
    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page: models.Page },
      checkEditorCap: async () => ({ readonly: false }),
      // editorCapCounter intentionally omitted
    });
    const onDisconnect = createOnDisconnect({});

    const payload = makeAuthPayload(token, pageId, 'sock-failopen');
    const ctx = await onAuthenticate(payload);
    expect(ctx.readonly).toBe(false);

    // disconnect must not throw despite no counter being wired up.
    await expect(onDisconnect(makeDisconnectPayload(pageId, userId, 'sock-failopen', false))).resolves.toBeUndefined();
  });
});
