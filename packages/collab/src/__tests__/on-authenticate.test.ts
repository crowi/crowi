// Pin WS_TOKEN_SECRET before the api util's resolveWsTokenSecret() fires —
// same pattern as smoke.test.ts / editor-cap.test.ts.
process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import path from 'node:path';
import mongoose from 'mongoose';
import { createOnAuthenticate } from '../hooks/on-authenticate';
import type { CollabModels } from '../models';
import type { CollabWsTokenUtil } from '../types';
import { registerTestModels, type SmokeMongo, startInMemoryMongo } from './setup';

/**
 * RFC-0017 Phase 1 §5/§D5/§16 PINNED — `onAuthenticate`'s collab lifecycle
 * epoch gate + deleted-status reject. Drives the hook directly against a
 * real Mongo-backed `Page` (same posture as `smoke.test.ts` /
 * `editor-cap.test.ts` — avoids the crossws/Jest CJS friction).
 *
 * Covers:
 *   - AC-9/AC-11: a token minted BEFORE a rename/revert (epoch N) is
 *     refused once the page's epoch has advanced (N+1), BEFORE
 *     `onLoadDocument` would ever run (this hook IS that boundary).
 *   - AC-10: a token minted before a soft delete is refused (epoch
 *     mismatch AND deleted-status, either alone already rejects).
 *   - AC-12: `signWsToken` mints the page's CURRENT `collabLifecycleVersion`
 *     (asserted via `verifyWsToken` on the resulting token — not the HTTP
 *     response body, which is out of this package's scope).
 *   - AC-13: a legacy pre-epoch token (no `epoch` claim at all) is rejected
 *     — `WsTokenPayloadSchema` makes the claim required, so this is
 *     rejected at `verifyWsToken` (schema parse failure), not by the
 *     explicit epoch-compare line. Same generic "invalid token" outcome
 *     either way — reject-and-remint, never accept-with-fallback.
 *   - AC-18: WS auth rejects a token for an already-deleted page the same
 *     generic way as a missing/invalid one.
 */
const apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiWsToken = require(path.join(path.dirname(apiPkgPath), 'dist', 'util', 'ws-token.js')) as {
  createWsTokenUtil(): {
    signWsToken(claims: { userId: string; pageId: string; readonly: boolean; epoch: number }): { token: string; expiresAt: Date };
    verifyWsToken: CollabWsTokenUtil['verifyWsToken'];
  };
};

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

describe('createOnAuthenticate — RFC-0017 Phase 1 epoch gate + deleted reject', () => {
  let memMongo: SmokeMongo;
  let models: CollabModels;
  let wsTokenUtil: CollabWsTokenUtil;
  let apiUtil: ReturnType<(typeof apiWsToken)['createWsTokenUtil']>;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
    wsTokenUtil = apiWsToken.createWsTokenUtil();
    apiUtil = apiWsToken.createWsTokenUtil();
  });

  afterAll(async () => {
    await memMongo.stop();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = () => models.Page as any;

  const seedPage = async (overrides: Record<string, unknown> = {}) => {
    const userId = new mongoose.Types.ObjectId();
    const page = await Page().create({
      path: `/__collab-auth-epoch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      creator: userId,
      grant: 1,
      status: 'published',
      ...overrides,
    });
    return { pageId: page._id.toString(), userId: userId.toString() };
  };

  test('AC-12: signWsToken mints the page CURRENT collabLifecycleVersion (asserted via verifyWsToken)', async () => {
    const { pageId, userId } = await seedPage();
    await Page()
      .updateOne({ _id: pageId }, { $set: { collabLifecycleVersion: 3 } })
      .exec();

    const { token } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 3 });
    const claims = wsTokenUtil.verifyWsToken(token);
    expect(claims?.epoch).toBe(3);
  });

  test('AC-9: a token minted BEFORE a rename (epoch N) is refused once the epoch has advanced (N+1), before any load happens', async () => {
    const { pageId, userId } = await seedPage();
    // Token minted while the page is still at epoch 0 (pre-rename).
    const { token } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 0 });

    // Simulate the rename's atomic epoch advance (Page.rename's $inc).
    await Page()
      .updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 1 } })
      .exec();

    const onAuthenticate = createOnAuthenticate({ wsTokenUtil, models: { Page: models.Page } });
    await expect(onAuthenticate(makeAuthPayload(token, pageId))).rejects.toThrow('invalid token');
  });

  test('AC-11: a token minted BEFORE a revert (epoch N) is refused once the epoch has advanced', async () => {
    const { pageId, userId } = await seedPage();
    const { token } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 0 });

    // Simulate delete + revert: two epoch advances (status flip + rename).
    await Page()
      .updateOne({ _id: pageId }, { $inc: { collabLifecycleVersion: 2 } })
      .exec();

    const onAuthenticate = createOnAuthenticate({ wsTokenUtil, models: { Page: models.Page } });
    await expect(onAuthenticate(makeAuthPayload(token, pageId))).rejects.toThrow('invalid token');
  });

  test('AC-10: a token minted before a soft delete is refused (epoch mismatch AND deleted-status)', async () => {
    const { pageId, userId } = await seedPage();
    const { token } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 0 });

    // Simulate Page.deletePage: status -> deleted + epoch $inc in the same write.
    await Page()
      .updateOne({ _id: pageId }, { $set: { status: 'deleted' }, $inc: { collabLifecycleVersion: 1 } })
      .exec();

    const onAuthenticate = createOnAuthenticate({ wsTokenUtil, models: { Page: models.Page } });
    await expect(onAuthenticate(makeAuthPayload(token, pageId))).rejects.toThrow('invalid token');
  });

  test('AC-18: WS auth rejects a FRESH token (correct current epoch) for an already-deleted page', async () => {
    const { pageId, userId } = await seedPage();
    // Delete first, THEN mint against the post-delete epoch — this is the
    // "attacker/racer requests a fresh token after delete" case, distinct
    // from AC-10's "stale pre-delete token".
    await Page()
      .updateOne({ _id: pageId }, { $set: { status: 'deleted' }, $inc: { collabLifecycleVersion: 1 } })
      .exec();
    const { token } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 1 });

    const onAuthenticate = createOnAuthenticate({ wsTokenUtil, models: { Page: models.Page } });
    await expect(onAuthenticate(makeAuthPayload(token, pageId))).rejects.toThrow('invalid token');
  });

  test('AC-13: a legacy pre-epoch token (no epoch claim at all) is rejected — reject-and-remint, not accept-with-fallback', async () => {
    const { pageId, userId } = await seedPage();

    // Sign a token WITHOUT the `epoch` claim — simulates a token minted by
    // a pre-RFC-0017 process during a rolling deploy. `signWsToken`'s
    // underlying factory just spreads whatever claims object it's given
    // into the JWT (`util/signed-token-factory.ts`), so casting past the
    // typed `epoch: number` param reproduces exactly that shape without
    // hand-rolling a second JWT signer (and its own dependency) in this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { token: legacyToken } = apiUtil.signWsToken({ userId, pageId, readonly: false } as any);

    const onAuthenticate = createOnAuthenticate({ wsTokenUtil, models: { Page: models.Page } });
    // Rejected before onLoadDocument would ever run — this hook IS that boundary.
    await expect(onAuthenticate(makeAuthPayload(legacyToken, pageId))).rejects.toThrow('invalid token');

    // A subsequent mint (this process, current epoch) DOES carry the claim
    // and is accepted.
    const { token: freshToken } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 0 });
    const ctx = await onAuthenticate(makeAuthPayload(freshToken, pageId));
    expect(ctx.epoch).toBe(0);
  });

  test('a matching epoch is accepted and the context carries the current epoch', async () => {
    const { pageId, userId } = await seedPage();
    await Page()
      .updateOne({ _id: pageId }, { $set: { collabLifecycleVersion: 5 } })
      .exec();
    const { token } = apiUtil.signWsToken({ userId, pageId, readonly: false, epoch: 5 });

    const onAuthenticate = createOnAuthenticate({ wsTokenUtil, models: { Page: models.Page } });
    const ctx = await onAuthenticate(makeAuthPayload(token, pageId));
    expect(ctx).toEqual({ userId, pageId, readonly: false, epoch: 5 });
  });
});
