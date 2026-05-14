// Pin WS_TOKEN_SECRET before the api util's resolveWsTokenSecret() fires
// (it captures the secret on first call). Matches the pattern in
// `packages/api/src/routes/ts-rest/page-collab.test.ts` so a test-run
// invoked with a hostile env still passes.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import path from 'node:path';
import mongoose from 'mongoose';
import * as Y from 'yjs';
import { startInMemoryMongo, type SmokeMongo } from './setup';
import { registerModels, type CollabModels } from '../models';
import { getWsTokenUtil, _resetWsTokenUtilCacheForTesting, type CollabWsTokenUtil } from '../ws-token';
import { createOnAuthenticate } from '../hooks/on-authenticate';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { createOnStoreDocument } from '../hooks/on-store-document';
import { createCompactor } from '../compaction';
import { CONTENT_FIELD } from '../yjs-doc';

/**
 * Phase 3 smoke test. Exercises the hook trio end-to-end without
 * spinning up Hocuspocus's WebSocket adapter (`crossws` ships ESM-only
 * and is incompatible with Jest's CJS runtime — running the full
 * server in a child process would slow the run and obscure the
 * assertion target).
 *
 *   - sign a wsToken with the api package's `createWsTokenUtil` (same
 *     `WS_TOKEN_SECRET`, same issuer, same TTL)
 *   - drive the verify-side `onAuthenticate` hook with a synthetic
 *     Hocuspocus payload and assert the returned context shape
 *   - call `onLoadDocument` against a fresh Y.Doc and assert the body
 *     seed lands in `Y.Text('content')`
 *   - mutate the doc, call `onStoreDocument`, and assert
 *     `Page.yjsState` is a non-empty Buffer that round-trips back to
 *     the same Y.Text content
 *
 * The WebSocket wiring inside Hocuspocus (sync protocol, awareness,
 * onChange debounce) is covered by Hocuspocus's own test suite — our
 * scope here is "do our hooks compose into a working DB-backed
 * checkpoint loop?".
 */

const apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiWsToken = require(path.join(path.dirname(apiPkgPath), 'dist', 'util', 'ws-token.js')) as {
  createWsTokenUtil(): {
    signWsToken(claims: { userId: string; pageId: string; readonly: boolean }): { token: string; expiresAt: Date };
  };
};

describe('@crowi/collab Phase 3 hook smoke', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let wsTokenUtil: CollabWsTokenUtil;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    models = registerModels();
    _resetWsTokenUtilCacheForTesting();
    wsTokenUtil = getWsTokenUtil();
  });

  afterAll(async () => {
    await memMongo.stop();
  });

  /**
   * Build a minimal `onAuthenticatePayload` for the hook driver.
   * Hocuspocus passes a richer object at runtime, but only the fields
   * we read are populated here so a future Hocuspocus surface change
   * lights up as a TS error at the import site, not a silent runtime
   * skip.
   */
  const makeAuthPayload = (token: string, pageId: string) =>
    ({
      documentName: pageId,
      token,
      requestParameters: new URLSearchParams(),
      requestHeaders: new Headers(),
      request: undefined as never,
      instance: undefined as never,
      socketId: 'test-socket',
      connectionConfig: { readOnly: false, isAuthenticated: false },
      providerVersion: null,
      context: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it('hooks compose into a complete connect → edit → persist → restore cycle', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;

    // 1. Seed a Page + Revision pair. The path / grant / status are
    //    set to the canonical "published, public" combination so we
    //    are not testing grant logic — that is Phase 2's HTTP
    //    handler's job.
    const userId = new mongoose.Types.ObjectId();
    const pagePath = `/__collab-smoke-${Date.now()}`;
    const revision = await Revision.create({
      path: pagePath,
      body: 'seed body\n',
      author: userId,
      format: 'markdown',
    });
    const page = await Page.create({
      path: pagePath,
      revision: revision._id,
      creator: userId,
      grant: 1, // GRANT_PUBLIC
      status: 'published',
    });
    const pageId = page._id.toString();

    // 2. Mint a wsToken from the api side and verify the collab side
    //    accepts it. This exercises the *cross-process* contract:
    //    same secret, same issuer, same TTL.
    const apiUtil = apiWsToken.createWsTokenUtil();
    const { token } = apiUtil.signWsToken({ userId: userId.toString(), pageId, readonly: false });

    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page: models.Page },
    });
    const authPayload = makeAuthPayload(token, pageId);
    const ctx = await onAuthenticate(authPayload);
    expect(ctx).toEqual({ userId: userId.toString(), pageId, readonly: false });
    // onAuthenticate mutates connectionConfig.readOnly so Hocuspocus's
    // protocol layer can also enforce it.
    expect(authPayload.connectionConfig.readOnly).toBe(false);

    // 3. onLoadDocument seeds a fresh Y.Doc from the revision body.
    //    Phase 4: PageYjsUpdate replay runs after the seed but is a
    //    no-op here because no append rows exist yet.
    const onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    });
    const loadedDoc = new Y.Doc();
    await onLoadDocument({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentName: pageId,
      document: loadedDoc,
      context: ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(loadedDoc.getText(CONTENT_FIELD).toString()).toBe('seed body\n');

    // 4. Simulate a user edit, then drive onStoreDocument with the
    //    mutated doc. The hook should persist a non-empty
    //    `Page.yjsState` plus `yjsCheckpointAt`.
    //
    //    Phase 4: onStoreDocument delegates to the shared compactor,
    //    which also clears any pending `PageYjsUpdate` rows that
    //    existed at snapshot time. We construct it here with the
    //    same shape `createCollabServer` uses in production.
    loadedDoc.getText(CONTENT_FIELD).insert(0, 'hello collab ');
    expect(loadedDoc.getText(CONTENT_FIELD).toString()).toBe('hello collab seed body\n');

    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    const onStoreDocument = createOnStoreDocument({ models: { Page: models.Page }, compactor });
    await onStoreDocument({
      documentName: pageId,
      document: loadedDoc,
      lastContext: ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // `.lean()` skips Mongoose's Buffer hydration so the field comes
    // back as a bson `Binary`. Refetch through the hydrated path to
    // assert the Buffer round-trip the production hooks rely on.
    const persisted = await Page.findById(pageId).select('yjsState yjsCheckpointAt').exec();
    expect(persisted?.yjsState).toBeInstanceOf(Buffer);
    expect((persisted?.yjsState as Buffer).length).toBeGreaterThan(0);
    expect(persisted?.yjsCheckpointAt).toBeInstanceOf(Date);

    // Phase 4 acceptance — after the compactor-driven store, no
    // residual PageYjsUpdate rows should remain for this page.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PageYjsUpdate = models.PageYjsUpdate as any;
    expect(await PageYjsUpdate.countDocuments({ pageId }).exec()).toBe(0);

    // 5. Round-trip — restore the checkpoint into a new Y.Doc via the
    //    same onLoadDocument and verify the content survives a
    //    process-restart-equivalent reload.
    const restoredDoc = new Y.Doc();
    await onLoadDocument({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentName: pageId,
      document: restoredDoc,
      context: ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(restoredDoc.getText(CONTENT_FIELD).toString()).toBe('hello collab seed body\n');
  });

  it('onAuthenticate rejects a token whose pageId does not match documentName', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherPageId = new mongoose.Types.ObjectId().toString();
    const apiUtil = apiWsToken.createWsTokenUtil();
    const { token } = apiUtil.signWsToken({ userId: userId.toString(), pageId: otherPageId, readonly: false });

    // documentName is a different page than the one the token was minted for.
    const Page = models.Page;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seededPage = await (Page as any).create({
      path: `/__collab-mismatch-${Date.now()}`,
      creator: userId,
      grant: 1,
      status: 'published',
    });

    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page },
    });
    await expect(onAuthenticate(makeAuthPayload(token, seededPage._id.toString()))).rejects.toThrow();
  });

  it('onAuthenticate rejects when no token is presented', async () => {
    const onAuthenticate = createOnAuthenticate({
      wsTokenUtil,
      models: { Page: models.Page },
    });
    await expect(onAuthenticate(makeAuthPayload('', new mongoose.Types.ObjectId().toString()))).rejects.toThrow(/authentication required/);
  });

  it('onLoadDocument falls back to revision body when yjsState is corrupt', async () => {
    // Y.applyUpdate throws on an arbitrary byte sequence; the hook
    // must catch + warn + reseed from the revision body so a one-bad-
    // checkpoint page is still openable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const userId = new mongoose.Types.ObjectId();
    const pagePath = `/__collab-corrupt-${Date.now()}`;
    const revision = await Revision.create({ path: pagePath, body: 'fallback body', author: userId, format: 'markdown' });
    const page = await Page.create({
      path: pagePath,
      revision: revision._id,
      creator: userId,
      grant: 1,
      status: 'published',
      // Deliberately invalid Yjs update payload.
      yjsState: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    });

    const onLoadDocument = createOnLoadDocument({ models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate } });
    const doc = new Y.Doc();
    await onLoadDocument({
      documentName: page._id.toString(),
      document: doc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(doc.getText(CONTENT_FIELD).toString()).toBe('fallback body');
  });

  it('onLoadDocument leaves the Y.Doc empty when a page has no revision', async () => {
    // Defensive: a Page row with no `revision` pointer (e.g. mid-
    // creation race) must not crash the hook — the editor should
    // simply open an empty document.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    const page = await Page.create({
      path: `/__collab-norev-${Date.now()}`,
      creator: new mongoose.Types.ObjectId(),
      grant: 1,
      status: 'published',
    });

    const onLoadDocument = createOnLoadDocument({ models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate } });
    const doc = new Y.Doc();
    await onLoadDocument({
      documentName: page._id.toString(),
      document: doc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(doc.getText(CONTENT_FIELD).toString()).toBe('');
  });

  it('onStoreDocument skips persistence when lastContext.readonly is true', async () => {
    // Defence in depth: even if a readonly client somehow reaches the
    // store hook, the hook should refuse to overwrite `Page.yjsState`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Page = models.Page as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Revision = models.Revision as any;
    const userId = new mongoose.Types.ObjectId();
    const pagePath = `/__collab-ro-${Date.now()}`;
    const revision = await Revision.create({ path: pagePath, body: 'original', author: userId, format: 'markdown' });
    const page = await Page.create({
      path: pagePath,
      revision: revision._id,
      creator: userId,
      grant: 1,
      status: 'published',
    });
    const pageId = page._id.toString();

    // Snapshot before — schema defaults `yjsState` / `yjsCheckpointAt`
    // to null, so compare end-to-end that the readonly path leaves
    // both untouched.
    const before = await Page.findById(pageId).select('yjsState yjsCheckpointAt').exec();
    const compactor = createCompactor({
      models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
    });
    const onStoreDocument = createOnStoreDocument({ models: { Page: models.Page }, compactor });
    const doc = new Y.Doc();
    doc.getText(CONTENT_FIELD).insert(0, 'attempted readonly edit');
    await onStoreDocument({
      documentName: pageId,
      document: doc,
      lastContext: { userId: userId.toString(), pageId, readonly: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const after = await Page.findById(pageId).select('yjsState yjsCheckpointAt').exec();
    expect(after?.yjsState).toEqual(before?.yjsState);
    expect(after?.yjsCheckpointAt).toEqual(before?.yjsCheckpointAt);
  });
});
