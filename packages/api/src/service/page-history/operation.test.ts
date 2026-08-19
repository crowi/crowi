import { Types } from 'mongoose';
import { STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { completeOperation, createPageHistoryOperation, resolvePageHistoryOperation, resumeStrandedTransitions } from './operation';
import type { CreateOperationInput } from './operation';
import { enterTransition } from './transition';
import type { PageTransitionInput } from './transition';

/**
 * RFC-0021 Phase 2c-2a — the operation record and the operator's sweep
 * (AC-20..AC-28, AC-31, AC-34, and the operation-layer halves of AC-17/AC-19).
 *
 * The runner-side halves (`already-settled` / `page-missing` outcomes) live in
 * `transition.test.ts`; what this file pins is what the sweep does with them.
 */
describe('service/page-history/operation (RFC-0021 Phase 2c-2a)', () => {
  let Page;
  let Revision;
  let PageHistoryOperation;
  let user;
  let keySeq = 0;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryOperation = crowi.model('PageHistoryOperation');

    const [testUser] = await Fixture.generate('User', [{ name: 'Operation Tester', username: 'operation-tester', email: 'operation-tester@example.com' }]);
    user = testUser;
  });

  beforeEach(async () => {
    await PageHistoryOperation.deleteMany({});
  });

  /** 16-128 URL-safe characters, unique per call so tests never collide on the idempotency index. */
  const validKey = () => `idem-key-${String(keySeq++).padStart(6, '0')}-abcdefgh`;

  async function createReadyPage(path: string) {
    const page = await Page.create({
      path,
      creator: user._id,
      lastUpdateUser: user._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      redirectTo: null,
      grant: Page.GRANT_PUBLIC,
      status: STATUS_PUBLISHED,
      grantedUsers: [user._id],
    });
    const revision = await Revision.prepareRevision(page, 'body', user, { format: 'markdown' });
    await Page.pushRevision(page, revision, user);
    return Page.findById(page._id);
  }

  function createInput(pageId: Types.ObjectId, fromPath: string, toPath: string, overrides: Partial<CreateOperationInput> = {}): CreateOperationInput {
    return {
      actor: user._id,
      command: 'rename',
      idempotencyKey: validKey(),
      operationId: `op-${fromPath}-${toPath}`,
      requestFingerprint: `fp-${toPath}`,
      page: pageId,
      fromPath,
      toPath,
      fromStatus: STATUS_PUBLISHED,
      fromStatusPresent: true,
      toStatus: STATUS_PUBLISHED,
      createRedirect: false,
      source: 'web',
      ...overrides,
    };
  }

  function transitionInput(pageId: Types.ObjectId, operationId: string, fromPath: string, toPath: string): PageTransitionInput {
    return {
      pageId,
      operationId,
      kind: 'rename',
      fromPath,
      toPath,
      fromStatus: STATUS_PUBLISHED,
      fromStatusPresent: true,
      toStatus: STATUS_PUBLISHED,
      actor: user._id,
      source: 'web',
      buildEvent: () => ({ kind: 'page_renamed', payload: { fromPath, toPath, redirectCreated: false, subtree: false } }),
    };
  }

  describe('AC-20: resolve creates nothing', () => {
    test('an unknown key resolves to a miss and leaves the collection empty', async () => {
      const resolution = await resolvePageHistoryOperation(crowi, { actor: user._id, command: 'rename', idempotencyKey: validKey() }, 'fp');

      expect(resolution).toEqual({ kind: 'miss' });
      expect(await PageHistoryOperation.countDocuments({})).toBe(0);
    });
  });

  describe('AC-21: the unique index arbitrates a concurrent claim', () => {
    test('the loser re-reads the winner and compares fingerprints', async () => {
      const page = await createReadyPage('/operation/ac21');
      const key = validKey();
      const first = await createPageHistoryOperation(crowi, createInput(page._id, '/operation/ac21', '/operation/ac21-moved', { idempotencyKey: key }));
      expect(first.kind).toBe('created');

      // Same key, same request: the loser sees the winner, not an error.
      const sameRequest = await createPageHistoryOperation(
        crowi,
        createInput(page._id, '/operation/ac21', '/operation/ac21-moved', { idempotencyKey: key, operationId: 'op-loser' }),
      );
      expect(sameRequest.kind).toBe('lost');
      expect(sameRequest.kind === 'lost' && sameRequest.resolution.kind).toBe('in-flight');

      // Same key, different request: the fingerprint is what catches it.
      const otherRequest = await createPageHistoryOperation(
        crowi,
        createInput(page._id, '/operation/ac21', '/operation/ac21-elsewhere', {
          idempotencyKey: key,
          operationId: 'op-loser-2',
          requestFingerprint: 'fp-different',
        }),
      );
      expect(otherRequest.kind === 'lost' && otherRequest.resolution.kind).toBe('fingerprint-mismatch');

      expect(await PageHistoryOperation.countDocuments({ idempotencyKey: key })).toBe(1);
    });
  });

  describe('AC-22: the insert writes the command input in full', () => {
    test('every durable field is present on the raw document, not defaulted', async () => {
      const page = await createReadyPage('/operation/ac22');
      const input = createInput(page._id, '/operation/ac22', '/operation/ac22-moved', { createRedirect: true });
      await createPageHistoryOperation(crowi, input);

      const raw = await PageHistoryOperation.collection.findOne({ operationId: input.operationId });
      expect(raw.page).toEqual(page._id);
      expect(raw.fromPath).toBe('/operation/ac22');
      expect(raw.toPath).toBe('/operation/ac22-moved');
      expect(raw.fromStatus).toBe(STATUS_PUBLISHED);
      expect(raw.fromStatusPresent).toBe(true);
      expect(raw.toStatus).toBe(STATUS_PUBLISHED);
      expect(raw.createRedirect).toBe(true);
      expect(raw.source).toBe('web');
    });
  });

  describe('AC-31: completing an operation starts its retention clock', () => {
    test('result and expiresAt are written together', async () => {
      const page = await createReadyPage('/operation/ac31');
      const input = createInput(page._id, '/operation/ac31', '/operation/ac31-moved');
      await createPageHistoryOperation(crowi, input);

      await completeOperation(crowi, input.operationId, { status: 'succeeded' });

      const raw = await PageHistoryOperation.collection.findOne({ operationId: input.operationId });
      expect(raw.result.status).toBe('succeeded');
      // In flight the record must not expire out from under its own execution,
      // so the TTL only starts once there is a terminal answer to retain.
      expect(raw.expiresAt.getTime()).toBeGreaterThan(raw.result.completedAt.getTime());
    });

    test('a failed result keeps the code and message a replay will answer with', async () => {
      const page = await createReadyPage('/operation/ac31-failed');
      const input = createInput(page._id, '/operation/ac31-failed', '/operation/ac31-failed-moved');
      await createPageHistoryOperation(crowi, input);

      await completeOperation(crowi, input.operationId, {
        status: 'failed',
        code: 'PAGE_TRANSITION_INCOMPLETE',
        message: 'stopped mid-move',
      });

      const resolution = await resolvePageHistoryOperation(crowi, input, input.requestFingerprint);
      expect(resolution.kind).toBe('settled');
      expect(resolution.kind === 'settled' && resolution.operation.result?.code).toBe('PAGE_TRANSITION_INCOMPLETE');
      expect(resolution.kind === 'settled' && resolution.operation.result?.message).toBe('stopped mid-move');
    });
  });

  describe('AC-17b/AC-19b/AC-24: the sweep settles what it can classify', () => {
    test('a landed move is completed as succeeded', async () => {
      const page = await createReadyPage('/operation/ac17b');
      // The page already sits at the destination with no transition held.
      const input = createInput(page._id, '/operation/ac17b-from', '/operation/ac17b');
      await createPageHistoryOperation(crowi, input);

      const result = await resumeStrandedTransitions(crowi);

      expect(result.reports).toContainEqual(
        expect.objectContaining({ operationId: input.operationId, action: 'completed', reason: 'transition-already-settled' }),
      );
      const raw = await PageHistoryOperation.collection.findOne({ operationId: input.operationId });
      expect(raw.result.status).toBe('succeeded');
    });

    test('a vanished page is completed as succeeded (AC-19b)', async () => {
      const page = await createReadyPage('/operation/ac19b');
      const input = createInput(page._id, '/operation/ac19b', '/operation/ac19b-moved');
      await createPageHistoryOperation(crowi, input);
      await Page.collection.deleteOne({ _id: page._id });

      const result = await resumeStrandedTransitions(crowi);

      expect(result.reports).toContainEqual(expect.objectContaining({ operationId: input.operationId, action: 'completed', reason: 'page-deleted' }));
      const raw = await PageHistoryOperation.collection.findOne({ operationId: input.operationId });
      expect(raw.result.status).toBe('succeeded');
    });

    test('AC-24: an operation that never entered is terminated as failed', async () => {
      const page = await createReadyPage('/operation/ac24');
      // The page is still at the source and holds no transition.
      const input = createInput(page._id, '/operation/ac24', '/operation/ac24-moved');
      await createPageHistoryOperation(crowi, input);

      const result = await resumeStrandedTransitions(crowi);

      expect(result.reports).toContainEqual(expect.objectContaining({ operationId: input.operationId, action: 'completed', reason: 'abandoned-before-entry' }));
      const raw = await PageHistoryOperation.collection.findOne({ operationId: input.operationId });
      expect(raw.result.status).toBe('failed');
      expect(raw.result.code).toBe('PAGE_TRANSITION_INCOMPLETE');
    });
  });

  describe('AC-25/AC-34: what the sweep refuses to touch', () => {
    test('AC-34: a held transition with no resumer wired in is reported, not rewritten', async () => {
      const page = await createReadyPage('/operation/ac34');
      const input = createInput(page._id, '/operation/ac34', '/operation/ac34-moved');
      await createPageHistoryOperation(crowi, input);
      await enterTransition(crowi, transitionInput(page._id, input.operationId, '/operation/ac34', '/operation/ac34-moved'));
      const before = await Page.collection.findOne({ _id: page._id });

      const result = await resumeStrandedTransitions(crowi);

      expect(result.reports).toContainEqual(
        expect.objectContaining({
          operationId: input.operationId,
          pageId: String(page._id),
          path: '/operation/ac34-moved',
          action: 'blocked',
          reason: 'no-resumer-registered',
        }),
      );
      const after = await Page.collection.findOne({ _id: page._id });
      expect(after.path).toBe(before.path);
      expect(after.status).toBe(STATUS_RENAMING);
      expect(after.historyTransition.operationId).toBe(input.operationId);
      // Nothing terminal was written either — the operation is still open.
      expect(await PageHistoryOperation.collection.findOne({ operationId: input.operationId })).toMatchObject({ result: null });
    });

    test('a held transition IS finished when a resumer is wired in', async () => {
      const page = await createReadyPage('/operation/ac34-wired');
      const input = createInput(page._id, '/operation/ac34-wired', '/operation/ac34-wired-moved');
      await createPageHistoryOperation(crowi, input);
      await enterTransition(crowi, transitionInput(page._id, input.operationId, '/operation/ac34-wired', '/operation/ac34-wired-moved'));

      const seen: string[] = [];
      const result = await resumeStrandedTransitions(crowi, {
        resumeCommand: async (operation) => {
          seen.push(operation.operationId);
          return 'resumed';
        },
      });

      expect(seen).toEqual([input.operationId]);
      expect(result.reports).toContainEqual(expect.objectContaining({ operationId: input.operationId, action: 'resumed' }));
    });

    test('AC-25: a page in an unrecognised state is reported with its identifiers and left alone', async () => {
      const page = await createReadyPage('/operation/ac25');
      // Neither the source nor the destination the operation recorded.
      const input = createInput(page._id, '/operation/ac25-from', '/operation/ac25-to');
      await createPageHistoryOperation(crowi, input);

      const result = await resumeStrandedTransitions(crowi);

      expect(result.reports).toContainEqual({
        operationId: input.operationId,
        pageId: String(page._id),
        path: '/operation/ac25',
        action: 'blocked',
        reason: 'unrecognised-page-state',
      });
      expect(await PageHistoryOperation.collection.findOne({ operationId: input.operationId })).toMatchObject({ result: null });
    });
  });

  describe('AC-28: the transition cursor is its own', () => {
    test('resumeAfterOperationId skips only what precedes it', async () => {
      const first = await createReadyPage('/operation/ac28-a');
      const second = await createReadyPage('/operation/ac28-b');
      const firstInput = createInput(first._id, '/operation/ac28-a-from', '/operation/ac28-a');
      const secondInput = createInput(second._id, '/operation/ac28-b-from', '/operation/ac28-b');
      await createPageHistoryOperation(crowi, firstInput);
      await createPageHistoryOperation(crowi, secondInput);

      const result = await resumeStrandedTransitions(crowi, { resumeAfterOperationId: firstInput.operationId });

      expect(result.scannedOperations).toBe(1);
      expect(result.reports.map((r) => r.operationId)).toEqual([secondInput.operationId]);
    });
  });
});
