import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { type PageDocument, type PageModel, STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import type { PageHistoryEventModel } from 'src/models/page-history-event';
import type { PageHistoryOperationModel } from 'src/models/page-history-operation';
import type { RevisionModel } from 'src/models/revision';
import type { UserDocument } from 'src/models/user';
import { crowi, Fixture } from 'src/test/setup';
import { runPageHistoryRepair } from 'src/util/page-history-repair';
import { RENAME_TREE_CONCURRENCY } from 'src/util/map-with-concurrency';

import { deriveMemberKey, resumeSubtreeMemberCommand, settleSubtreeRootAfterMember, subtreeRenameCommand } from './subtree-rename';

describe('service/page-history/commands/subtree-rename (RFC-0021 Phase 2c-2b)', () => {
  let Page: PageModel;
  let Revision: RevisionModel;
  let PageHistoryEvent: PageHistoryEventModel;
  let PageHistoryOperation: PageHistoryOperationModel;
  let user: UserDocument;
  let otherUser: UserDocument;
  let sequence = 0;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    PageHistoryOperation = crowi.model('PageHistoryOperation');
    [user, otherUser] = await Fixture.generate('User', [
      { name: 'Subtree Rename Tester', username: 'subtree-rename-tester', email: 'subtree-rename-tester@example.com' },
      { name: 'Subtree Rename Other', username: 'subtree-rename-other', email: 'subtree-rename-other@example.com' },
    ]);
  });

  beforeEach(async () => {
    await Promise.all([PageHistoryEvent.deleteMany({}), PageHistoryOperation.deleteMany({})]);
  });

  const nextKey = () => `subtree-key-${String(sequence++).padStart(6, '0')}-abcdef`;

  async function createReadyPage(path: string): Promise<PageDocument> {
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
    return (await Page.findById(page._id)) as PageDocument;
  }

  const run = (page: PageDocument, toPath: string, idempotencyKey = nextKey()) =>
    subtreeRenameCommand(crowi, {
      page,
      pageId: page._id,
      toPath,
      actor: user._id,
      user,
      source: 'web',
      idempotencyKey,
      requestFingerprint: `fingerprint-${String(page._id)}-${toPath}`,
      createRedirectPage: false,
    });

  async function createSealedSubtreeState(root: PageDocument, child: PageDocument, destination: string, key: string) {
    const childDestination = `${destination}${child.path.slice(root.path.length)}`;
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `root-${key}`,
      requestFingerprint: `fingerprint-${String(root._id)}-${destination}`,
      memberPageIds: [root._id, child._id],
      groupOperationId: `group-${key}`,
    });
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename_member',
      idempotencyKey: deriveMemberKey(key, root._id),
      operationId: `root-member-${key}`,
      requestFingerprint: createMemberFingerprint(root._id, root.path, destination),
      page: root._id,
      fromPath: root.path,
      toPath: destination,
      fromStatus: root.status,
      fromStatusPresent: true,
      toStatus: root.status,
      createRedirect: false,
      source: 'web',
      result: { status: 'succeeded', completedAt: new Date() },
    });
    const childMember = await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename_member',
      idempotencyKey: deriveMemberKey(key, child._id),
      operationId: `child-member-${key}`,
      requestFingerprint: createMemberFingerprint(child._id, child.path, childDestination),
      page: child._id,
      fromPath: child.path,
      toPath: childDestination,
      fromStatus: child.status,
      fromStatusPresent: true,
      toStatus: child.status,
      createRedirect: false,
      source: 'web',
    });
    await Page.updateOne({ _id: root._id }, { $set: { path: destination } });
    return { childDestination, childMember };
  }

  test('deriveMemberKey is deterministic, page-specific, and valid as an idempotency key', () => {
    const pageA = new Types.ObjectId('64b000000000000000000001');
    const pageB = new Types.ObjectId('64b000000000000000000002');

    expect(deriveMemberKey('abcdefghijklmnop', pageA)).toBe(deriveMemberKey('abcdefghijklmnop', pageA));
    expect(deriveMemberKey('abcdefghijklmnop', pageA)).not.toBe(deriveMemberKey('abcdefghijklmnop', pageB));
    expect(deriveMemberKey('abcdefghijklmnop', pageA)).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  test('AC-16: subtreeRenameCommand never runs more than the legacy limit concurrently', async () => {
    const root = await createReadyPage('/subtree/concurrency-limit');
    const members = [root];
    for (let index = 0; index < RENAME_TREE_CONCURRENCY + 2; index += 1) {
      members.push(await createReadyPage(`/subtree/concurrency-limit/child-${index}`));
    }
    let active = 0;
    let maximum = 0;
    let reachedLimit: (() => void) | undefined;
    const atLimit = new Promise<void>((resolve) => {
      reachedLimit = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updateRevisionListByPath = Revision.updateRevisionListByPath.bind(Revision);
    const revisionSpy = jest.spyOn(Revision, 'updateRevisionListByPath').mockImplementation(async (path, updateData) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active === RENAME_TREE_CONCURRENCY) reachedLimit?.();
      await gate;
      try {
        return await updateRevisionListByPath(path, updateData);
      } finally {
        active -= 1;
      }
    });

    const running = subtreeRenameCommand(crowi, {
      page: root,
      pageId: root._id,
      memberPages: members,
      toPath: '/subtree/concurrency-limit-moved',
      actor: user._id,
      user,
      source: 'web',
      idempotencyKey: nextKey(),
      requestFingerprint: `fingerprint-${String(root._id)}-concurrency-limit`,
      createRedirectPage: false,
    });
    await atLimit;

    expect(maximum).toBe(RENAME_TREE_CONCURRENCY);
    release?.();
    await expect(running).resolves.toMatchObject({ status: 'completed', failures: [] });
    revisionSpy.mockRestore();
  });

  test('moves every sealed member through ordinary rename records while grouping subtree events', async () => {
    const root = await createReadyPage('/subtree/ac1');
    const child = await createReadyPage('/subtree/ac1/child');
    const grandchild = await createReadyPage('/subtree/ac1/child/grandchild');

    const outcome = await run(root, '/subtree/moved');

    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' && outcome.failures).toEqual([]);
    expect(await Page.findById(root._id).lean()).toMatchObject({ path: '/subtree/moved' });
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: '/subtree/moved/child' });
    expect(await Page.findById(grandchild._id).lean()).toMatchObject({ path: '/subtree/moved/child/grandchild' });

    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename' }).lean();
    expect(rootOperation.memberPageIds.map(String).sort()).toEqual([root._id, child._id, grandchild._id].map(String).sort());
    expect(rootOperation.groupOperationId).toEqual(expect.any(String));
    expect(rootOperation).not.toHaveProperty('page');
    expect(rootOperation).not.toHaveProperty('fromPath');
    expect(rootOperation).not.toHaveProperty('toPath');
    expect(rootOperation.result.status).toBe('succeeded');

    const members = await PageHistoryOperation.find({ command: 'subtree_rename_member' }).lean();
    expect(members).toHaveLength(3);
    expect(members.every((member) => member.page && member.fromPath && member.toPath && member.source === 'web')).toBe(true);
    expect(new Set(members.map((member) => member.operationId)).size).toBe(3);

    const events = await PageHistoryEvent.find({ kind: 'page_renamed', page: { $in: [root._id, child._id, grandchild._id] } }).lean();
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.payload.subtree === true)).toBe(true);
    expect(new Set(events.map((event) => event.operationId))).toEqual(new Set([rootOperation.groupOperationId]));
  });

  test('AC-28: a member transition conflict is transient and leaves its member and root unsettled', async () => {
    const root = await createReadyPage('/subtree/partial');
    const blocked = await createReadyPage('/subtree/partial/blocked');
    const sibling = await createReadyPage('/subtree/partial/sibling');
    await Page.updateOne({ _id: blocked._id }, { $set: { historyTransition: { operationId: 'another-operation', kind: 'rename' } } });

    const outcome = await run(root, '/subtree/partial-moved');

    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' && outcome.successes.map((page) => String(page._id)).sort()).toEqual([root._id, sibling._id].map(String).sort());
    expect(outcome.status === 'completed' && outcome.failures).toEqual([
      { oldPath: '/subtree/partial/blocked', error: 'Failed to update page (/subtree/partial/blocked).' },
    ]);
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: blocked._id }).lean()).result).toBeNull();
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename' }).lean()).result).toBeNull();
  });

  test('re-enters a result-null root from its seal without scanning again', async () => {
    const root = await createReadyPage('/subtree/reentry');
    await createReadyPage('/subtree/reentry/child');
    const key = nextKey();
    const first = await run(root, '/subtree/reentry-moved', key);
    expect(first.status).toBe('completed');

    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });
    await PageHistoryOperation.updateOne({ _id: rootOperation._id }, { $set: { result: null, expiresAt: null } });
    const scanSpy = jest.spyOn(Page, 'findListByStartWith');
    const replay = await run(await Page.findById(root._id), '/subtree/reentry-moved', key);
    const scanCalls = scanSpy.mock.calls.length;
    scanSpy.mockRestore();

    expect(replay.status).toBe('completed');
    expect(scanCalls).toBe(0);
    expect(await PageHistoryEvent.countDocuments({ operationId: rootOperation.groupOperationId })).toBe(2);
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result.status).toBe('succeeded');
  });

  test('AC-20: a replay continues from a root sealed before any member record was created', async () => {
    const root = await createReadyPage('/subtree/root-only-crash');
    const child = await createReadyPage('/subtree/root-only-crash/child');
    const key = nextKey();
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `root-${key}`,
      requestFingerprint: `fingerprint-${String(root._id)}-/subtree/root-only-moved`,
      memberPageIds: [root._id, child._id],
      groupOperationId: `group-${key}`,
    });
    const scanSpy = jest.spyOn(Page, 'findListByStartWith');

    const outcome = await run(root, '/subtree/root-only-moved', key);

    expect(outcome.status).toBe('completed');
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();
    expect(await PageHistoryOperation.countDocuments({ command: 'subtree_rename_member' })).toBe(2);
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: '/subtree/root-only-moved/child' });
  });

  test('AC-31: a page deleted after the seal settles its member moot', async () => {
    const root = await createReadyPage('/subtree/sealed-missing');
    const missing = await createReadyPage('/subtree/sealed-missing/gone');
    const key = nextKey();
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `root-${key}`,
      requestFingerprint: `fingerprint-${String(root._id)}-/subtree/sealed-missing-moved`,
      memberPageIds: [root._id, missing._id],
      groupOperationId: `group-${key}`,
    });
    await Page.deleteOne({ _id: missing._id });

    const outcome = await run(root, '/subtree/sealed-missing-moved', key);

    expect(outcome.status).toBe('completed');
    expect(await PageHistoryOperation.countDocuments({ command: 'subtree_rename_member' })).toBe(2);
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: missing._id }).lean())?.result?.status).toBe('moot');
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key }).lean())?.result?.status).toBe('succeeded');
  });

  test('a replay of an unsettled member does not unlink a redirect created after its first delivery', async () => {
    const root = await createReadyPage('/subtree/unlink-replay');
    const destination = '/subtree/unlink-replay-moved';
    const redirect = await Page.create({
      path: destination,
      creator: user._id,
      lastUpdateUser: user._id,
      redirectTo: '/elsewhere',
      grant: Page.GRANT_PUBLIC,
      status: STATUS_PUBLISHED,
      grantedUsers: [user._id],
    });
    const key = nextKey();
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `root-${key}`,
      requestFingerprint: `fingerprint-${String(root._id)}-${destination}`,
      memberPageIds: [root._id],
      groupOperationId: `group-${key}`,
    });
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename_member',
      idempotencyKey: deriveMemberKey(key, root._id),
      operationId: `member-${key}`,
      requestFingerprint: createMemberFingerprint(root._id, root.path, destination),
      page: root._id,
      fromPath: root.path,
      toPath: destination,
      fromStatus: root.status,
      fromStatusPresent: true,
      toStatus: root.status,
      createRedirect: false,
      source: 'web',
    });
    const member = await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id });

    const outcome = await run(root, destination, key);

    expect(outcome.status).toBe('completed');
    expect(await Page.findById(redirect._id)).not.toBeNull();
    expect((await PageHistoryOperation.findById(member._id).lean())?.result).toBeNull();
  });

  test('AC-29: a losing delivery cannot settle the member while the creator is still working', async () => {
    const root = await createReadyPage('/subtree/unlink-race');
    const destination = '/subtree/unlink-race-moved';
    const redirect = await Page.create({
      path: destination,
      creator: user._id,
      lastUpdateUser: user._id,
      redirectTo: '/elsewhere',
      grant: Page.GRANT_PUBLIC,
      status: STATUS_PUBLISHED,
      grantedUsers: [user._id],
    });
    const key = nextKey();
    let unlinkStarted: (() => void) | undefined;
    const atUnlink = new Promise<void>((resolve) => {
      unlinkStarted = resolve;
    });
    let releaseUnlink: (() => void) | undefined;
    const unlinkGate = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    const originalUnlink = Page.prototype.unlink as (this: PageDocument, unlinkingUser: unknown) => Promise<void>;
    const unlinkSpy = jest.spyOn(Page.prototype, 'unlink').mockImplementation(async function (this: PageDocument, unlinkingUser: unknown) {
      if (this._id.equals(redirect._id)) {
        unlinkStarted?.();
        await unlinkGate;
      }
      return originalUnlink.call(this, unlinkingUser);
    });

    const creatorDelivery = run(root, destination, key);
    await atUnlink;
    const losingDelivery = await run(root, destination, key);
    const resultWhileCreatorPaused = (await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id }).lean()).result;
    releaseUnlink?.();
    const creatorOutcome = await creatorDelivery;
    unlinkSpy.mockRestore();
    const replay = await run(root, destination, key);

    expect(losingDelivery.status === 'completed' && losingDelivery.failures).toHaveLength(1);
    expect(resultWhileCreatorPaused).toBeNull();
    expect(creatorOutcome.status === 'completed' && creatorOutcome.failures).toEqual([]);
    expect(replay.status === 'completed' && replay.failures).toEqual([]);
    expect(await Page.findById(root._id).lean()).toMatchObject({ path: destination });
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id }).lean()).result.status).toBe('succeeded');
  });

  test('AC-22: concurrent deliveries of one key move each sealed page once', async () => {
    const root = await createReadyPage('/subtree/concurrent');
    const child = await createReadyPage('/subtree/concurrent/child');
    const key = nextKey();
    let firstAfterEnter: (() => void) | undefined;
    const afterEnterStarted = new Promise<void>((resolve) => {
      firstAfterEnter = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const updateRevisionListByPath = Revision.updateRevisionListByPath.bind(Revision);
    let calls = 0;
    const revisionSpy = jest.spyOn(Revision, 'updateRevisionListByPath').mockImplementation(async (path, updateData) => {
      calls += 1;
      if (calls === 1) {
        firstAfterEnter?.();
        await firstGate;
      }
      return updateRevisionListByPath(path, updateData);
    });

    const firstDelivery = run(root, '/subtree/concurrent-moved', key);
    await afterEnterStarted;
    const secondDelivery = run(root, '/subtree/concurrent-moved', key);
    const secondOutcome = await secondDelivery;
    releaseFirst?.();
    const outcomes = [await firstDelivery, secondOutcome];
    revisionSpy.mockRestore();

    expect(outcomes.every((outcome) => outcome.status === 'completed')).toBe(true);
    expect(outcomes.every((outcome) => outcome.status === 'completed' && outcome.failures.length === 0)).toBe(true);
    expect(await Page.findById(root._id).lean()).toMatchObject({ path: '/subtree/concurrent-moved' });
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: '/subtree/concurrent-moved/child' });
    expect(await PageHistoryOperation.countDocuments({ command: 'subtree_rename_member' })).toBe(2);
    expect(await PageHistoryEvent.countDocuments({ page: { $in: [root._id, child._id] }, kind: 'page_renamed' })).toBe(2);
    expect(await PageHistoryOperation.countDocuments({ command: 'subtree_rename_member', 'result.status': 'succeeded' })).toBe(2);
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key }).lean()).result.status).toBe('succeeded');
  });

  test('a losing exit-CAS delivery settles its member from the grouped event instead of reporting failure', async () => {
    const root = await createReadyPage('/subtree/durable-authority');
    const child = await createReadyPage('/subtree/durable-authority/child');
    const destination = '/subtree/durable-authority-moved';
    const key = nextKey();
    const { childDestination, childMember } = await createSealedSubtreeState(root, child, destination, key);
    const memberKey = deriveMemberKey(key, child._id);

    // Both deliveries are held at the SAME afterEnter point (the sync every
    // real "two deliveries entered, one is about to lose the exit CAS"
    // interleaving needs) and released together.
    const updateRevisionListByPath = Revision.updateRevisionListByPath.bind(Revision);
    let afterEnterCalls = 0;
    let releaseAfterEnter: (() => void) | undefined;
    const afterEnterGate = new Promise<void>((resolve) => {
      releaseAfterEnter = resolve;
    });
    let bothAtGate: (() => void) | undefined;
    const bothAtGatePromise = new Promise<void>((resolve) => {
      bothAtGate = resolve;
    });
    const revisionSpy = jest.spyOn(Revision, 'updateRevisionListByPath').mockImplementation(async (path, updateData) => {
      afterEnterCalls += 1;
      if (afterEnterCalls === 2) bothAtGate?.();
      await afterEnterGate;
      return updateRevisionListByPath(path, updateData);
    });

    // Only the FIRST terminal write for this member is held — that is
    // whichever delivery reaches `completeOperation` first, normally the
    // exit-CAS winner. Holding it keeps `result` durably `null` until the
    // losing delivery has actually performed its decisive read.
    let trackFinalRead = false;
    let finalReadCalls = 0;
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const findOne = PageHistoryOperation.findOne.bind(PageHistoryOperation);
    const findOneSpy = jest.spyOn(PageHistoryOperation, 'findOne').mockImplementation((filter, projection, options) => {
      const query = findOne(filter, projection, options);
      const f = filter as { idempotencyKey?: string };
      if (trackFinalRead && f?.idempotencyKey === memberKey) {
        const exec = query.exec.bind(query);
        query.exec = (async () => {
          const value = await exec();
          finalReadCalls += 1;
          if (finalReadCalls === 1) releaseCompletion?.();
          return value;
        }) as typeof query.exec;
      }
      return query;
    });
    const findOneAndUpdate = PageHistoryOperation.findOneAndUpdate.bind(PageHistoryOperation);
    let completionCalls = 0;
    const completionSpy = jest.spyOn(PageHistoryOperation, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      const query = findOneAndUpdate(filter, update, options);
      const f = filter as { operationId?: string; result?: unknown };
      if (f?.operationId === childMember.operationId && f?.result === null) {
        completionCalls += 1;
        if (completionCalls === 1) {
          const exec = query.exec.bind(query);
          query.exec = (async () => {
            await completionGate;
            return exec();
          }) as typeof query.exec;
        }
      }
      return query;
    });

    const firstDelivery = run(root, destination, key);
    const secondDelivery = run(root, destination, key);
    await bothAtGatePromise;
    // Everything that reads this member's record before this point is one of
    // the two deliveries' own preliminary lookups, not the decisive read the
    // repro targets — only start counting once both are past afterEnter.
    trackFinalRead = true;
    releaseAfterEnter?.();

    const outcomes = await Promise.all([firstDelivery, secondDelivery]);
    revisionSpy.mockRestore();
    findOneSpy.mockRestore();
    completionSpy.mockRestore();

    expect(outcomes.every((outcome) => outcome.status === 'completed')).toBe(true);
    expect(outcomes.every((outcome) => outcome.status === 'completed' && outcome.failures.length === 0)).toBe(true);
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: childDestination });
    expect(await PageHistoryEvent.countDocuments({ page: child._id, kind: 'page_renamed' })).toBe(1);
    expect((await PageHistoryOperation.findById(childMember._id).lean()).result?.status).toBe('succeeded');
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key }).lean()).result?.status).toBe('succeeded');
  });

  test('an exception raised after the exit CAS commits still settles the member from durable evidence', async () => {
    const root = await createReadyPage('/subtree/catch-durable-evidence');
    const key = nextKey();
    const pageEvent = crowi.event('Page');
    const emitSpy = jest.spyOn(pageEvent, 'emit').mockImplementation(((name: string) => {
      // The transition (Page CAS + grouped event materialize) already
      // committed by the time this fires — throwing here reaches
      // `outcomeFromCurrentMember` through the `catch` in `subtreeRenameCommand`
      // with the durable evidence already in place, but `result` still null.
      if (name === 'update') throw new Error('a post-commit listener failed');
      return true;
    }) as never);

    let outcome: Awaited<ReturnType<typeof run>>;
    try {
      outcome = await run(root, '/subtree/catch-durable-evidence-moved', key);
    } finally {
      emitSpy.mockRestore();
    }

    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' && outcome.failures).toEqual([]);
    expect(await Page.findById(root._id).lean()).toMatchObject({ path: '/subtree/catch-durable-evidence-moved' });
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id }).lean()).result?.status).toBe('succeeded');
  });

  test('a failed durable-evidence read still reports member failure instead of asserting success', async () => {
    const root = await createReadyPage('/subtree/unreadable-evidence');
    const child = await createReadyPage('/subtree/unreadable-evidence/child');
    const destination = '/subtree/unreadable-evidence-moved';
    const key = nextKey();
    const { childDestination, childMember } = await createSealedSubtreeState(root, child, destination, key);
    const memberKey = deriveMemberKey(key, child._id);

    const revisionSpy = jest.spyOn(Revision, 'updateRevisionListByPath').mockRejectedValueOnce(new Error('transient revision write failure'));
    const findOne = PageHistoryOperation.findOne.bind(PageHistoryOperation);
    let matchingCalls = 0;
    const findOneSpy = jest.spyOn(PageHistoryOperation, 'findOne').mockImplementation((filter, projection, options) => {
      const f = filter as { idempotencyKey?: string };
      if (f?.idempotencyKey === memberKey) {
        matchingCalls += 1;
        // The first two matching reads are the delivery's own preliminary
        // lookups (unaffected by this repro); only the third — the decisive
        // read inside `outcomeFromCurrentMember` — fails here.
        if (matchingCalls > 2) throw new Error('durable evidence read failed');
      }
      return findOne(filter, projection, options);
    });

    let outcome: Awaited<ReturnType<typeof run>>;
    try {
      outcome = await run(root, destination, key);
    } finally {
      revisionSpy.mockRestore();
      findOneSpy.mockRestore();
    }

    expect(outcome.status === 'completed' && outcome.failures).toEqual([{ oldPath: child.path, error: `Failed to update page (${child.path}).` }]);
    expect((await PageHistoryOperation.findById(childMember._id).lean()).result).toBeNull();
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: childDestination, historyTransition: { operationId: childMember.operationId } });
  });

  test('AC-30: destination state is not completion evidence, but the grouped event row is', async () => {
    const root = await createReadyPage('/subtree/stale-derivation');
    const child = await createReadyPage('/subtree/stale-derivation/child');
    const destination = '/subtree/stale-derivation-moved';
    const key = nextKey();
    const { childDestination, childMember } = await createSealedSubtreeState(root, child, destination, key);
    await PageHistoryOperation.deleteOne({ _id: childMember._id });
    await Page.updateOne({ _id: child._id }, { $set: { path: childDestination } });

    await run(root, destination, key);

    const recreated = await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: child._id });
    expect(recreated.result).toBeNull();
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: childDestination });

    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });
    await PageHistoryEvent.create({
      page: child._id,
      sequence: 99,
      kind: 'page_renamed',
      actor: user._id,
      occurredAt: new Date(),
      operationId: recreated.operationId,
      source: 'web',
      payload: { fromPath: child.path, toPath: childDestination, redirectCreated: false, subtree: true },
    });
    expect(await PageHistoryEvent.countDocuments({ page: child._id, operationId: rootOperation.groupOperationId, kind: 'page_renamed' })).toBe(0);
    await runPageHistoryRepair(crowi, { transitions: true, minAgeMs: 0 });
    expect((await PageHistoryOperation.findById(recreated._id).lean()).result).toBeNull();

    await PageHistoryEvent.deleteMany({ page: child._id });
    await PageHistoryEvent.create({
      page: child._id,
      sequence: 99,
      kind: 'page_renamed',
      actor: user._id,
      occurredAt: new Date(),
      operationId: rootOperation.groupOperationId,
      source: 'web',
      payload: { fromPath: child.path, toPath: childDestination, redirectCreated: false, subtree: true },
    });
    await runPageHistoryRepair(crowi, { transitions: true, minAgeMs: 0 });
    expect((await PageHistoryOperation.findById(recreated._id).lean()).result?.status).toBe('succeeded');
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result?.status).toBe('succeeded');
  });

  test('the repair sweep settles the root after a missing subtree member becomes moot', async () => {
    const root = await createReadyPage('/subtree/sweep-moot');
    const child = await createReadyPage('/subtree/sweep-moot/child');
    const key = nextKey();
    const { childMember } = await createSealedSubtreeState(root, child, '/subtree/sweep-moot-moved', key);
    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });
    await Page.deleteOne({ _id: child._id });

    await runPageHistoryRepair(crowi, { transitions: true, minAgeMs: 0 });

    expect((await PageHistoryOperation.findById(childMember._id).lean()).result?.status).toBe('moot');
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result?.status).toBe('succeeded');
  });

  test('the repair sweep settles the root after an unentered subtree member ages out as failed', async () => {
    const root = await createReadyPage('/subtree/sweep-failed');
    const child = await createReadyPage('/subtree/sweep-failed/child');
    const key = nextKey();
    const { childMember } = await createSealedSubtreeState(root, child, '/subtree/sweep-failed-moved', key);
    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });

    await runPageHistoryRepair(crowi, { transitions: true, minAgeMs: 0 });

    expect((await PageHistoryOperation.findById(childMember._id).lean()).result?.status).toBe('failed');
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result?.status).toBe('succeeded');
  });

  test('a partial sealed member does not let the shared settlement helper settle the durable root', async () => {
    const root = await createReadyPage('/subtree/shared-partial');
    const child = await createReadyPage('/subtree/shared-partial/child');
    const key = nextKey();
    const { childMember } = await createSealedSubtreeState(root, child, '/subtree/shared-partial-moved', key);
    await PageHistoryOperation.updateOne({ _id: childMember._id }, { $set: { result: { status: 'partial', completedAt: new Date() } } });
    const rootMember = await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id });
    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });

    await settleSubtreeRootAfterMember(crowi, rootMember);

    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result).toBeNull();
  });

  test('the request path leaves the durable root unsettled when a sealed member result is partial', async () => {
    const root = await createReadyPage('/subtree/request-partial');
    const child = await createReadyPage('/subtree/request-partial/child');
    const destination = '/subtree/request-partial-moved';
    const key = nextKey();
    const { childMember } = await createSealedSubtreeState(root, child, destination, key);
    await PageHistoryOperation.updateOne({ _id: childMember._id }, { $set: { result: { status: 'partial', completedAt: new Date() } } });
    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });

    await run(root, destination, key);

    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result).toBeNull();
  });

  test('owned-elsewhere after this member committed leaves its durable result unsettled', async () => {
    const root = await createReadyPage('/subtree/owned-after-commit');
    const child = await createReadyPage('/subtree/owned-after-commit/child');
    const destination = '/subtree/owned-after-commit-moved';
    const laterPath = '/subtree/later-rename';
    const key = nextKey();
    const { childMember } = await createSealedSubtreeState(root, child, destination, key);
    await Page.updateOne(
      { _id: child._id },
      { $set: { path: laterPath, status: STATUS_RENAMING, historyTransition: { operationId: 'later-operation', kind: 'rename' } } },
    );

    await run(root, destination, key);

    expect((await PageHistoryOperation.findById(childMember._id).lean()).result).toBeNull();
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: laterPath });
  });

  test('contended while a sibling delivery enters leaves the shared member unsettled', async () => {
    const root = await createReadyPage('/subtree/contended-sibling');
    const child = await createReadyPage('/subtree/contended-sibling/child');
    const destination = '/subtree/contended-sibling-moved';
    const key = nextKey();
    const { childDestination, childMember } = await createSealedSubtreeState(root, child, destination, key);
    const findOneAndUpdate = Page.findOneAndUpdate.bind(Page);
    const enterSpy = jest.spyOn(Page, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      const transitionFilter = filter as { _id?: Types.ObjectId; historyTransition?: null };
      if (String(transitionFilter._id) === String(child._id) && transitionFilter.historyTransition === null) {
        return findOneAndUpdate({ _id: new Types.ObjectId() }, update, options);
      }
      return findOneAndUpdate(filter, update, options);
    });
    const findById = Page.findById.bind(Page);
    let classificationReads = 0;
    const findSpy = jest.spyOn(Page, 'findById').mockImplementation((pageId, projection, options) => {
      const query = findById(pageId, projection, options);
      const exec = query.exec.bind(query);
      query.exec = (async () => {
        const value = await exec();
        const selected = query.projection() as Record<string, unknown> | null;
        if (String(pageId) === String(child._id) && selected?.historyTransition === 1) {
          classificationReads += 1;
          if (classificationReads === 3) {
            await Page.updateOne(
              { _id: child._id },
              { $set: { path: childDestination, status: STATUS_RENAMING, historyTransition: { operationId: childMember.operationId, kind: 'rename' } } },
            );
          }
        }
        return value;
      }) as typeof query.exec;
      return query;
    });

    try {
      await run(root, destination, key);
    } finally {
      findSpy.mockRestore();
      enterSpy.mockRestore();
    }

    expect((await PageHistoryOperation.findById(childMember._id).lean()).result).toBeNull();
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: childDestination });
  });

  test('page-missing without a grouped event does not settle the durable member succeeded', async () => {
    const root = await createReadyPage('/subtree/missing-after-commit');
    const child = await createReadyPage('/subtree/missing-after-commit/child');
    const destination = '/subtree/missing-after-commit-moved';
    const key = nextKey();
    const { childDestination, childMember } = await createSealedSubtreeState(root, child, destination, key);
    const findOneAndUpdate = Page.findOneAndUpdate.bind(Page);
    const enterSpy = jest.spyOn(Page, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      const transitionFilter = filter as { _id?: Types.ObjectId; historyTransition?: null };
      if (String(transitionFilter._id) === String(child._id) && transitionFilter.historyTransition === null) {
        return findOneAndUpdate({ _id: new Types.ObjectId() }, update, options);
      }
      return findOneAndUpdate(filter, update, options);
    });
    const findById = Page.findById.bind(Page);
    let returnedMissing = false;
    const findSpy = jest.spyOn(Page, 'findById').mockImplementation((pageId, projection, options) => {
      const query = findById(pageId, projection, options);
      const exec = query.exec.bind(query);
      query.exec = (async () => {
        const selected = query.projection() as Record<string, unknown> | null;
        if (!returnedMissing && String(pageId) === String(child._id) && selected?.historyTransition === 1) {
          returnedMissing = true;
          await Page.updateOne({ _id: child._id }, { $set: { path: childDestination, historyTransition: null } });
          return null;
        }
        return exec();
      }) as typeof query.exec;
      return query;
    });

    try {
      await run(root, destination, key);
    } finally {
      findSpy.mockRestore();
      enterSpy.mockRestore();
    }

    expect((await PageHistoryOperation.findById(childMember._id).lean()).result).toBeNull();
    expect(await Page.findById(child._id).lean()).toMatchObject({ path: childDestination });
  });

  test('an exception after entry leaves the member repairable instead of settling it failed', async () => {
    const root = await createReadyPage('/subtree/after-enter-error');
    const key = nextKey();
    const revisionSpy = jest.spyOn(Revision, 'updateRevisionListByPath').mockRejectedValueOnce(new Error('transient revision write failure'));

    const first = await run(root, '/subtree/after-enter-error-moved', key);
    revisionSpy.mockRestore();

    const member = await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id });
    expect(first.status === 'completed' && first.failures).toHaveLength(1);
    expect(member.result).toBeNull();
    expect(await Page.findById(root._id).lean()).toMatchObject({
      path: '/subtree/after-enter-error-moved',
      status: STATUS_RENAMING,
      historyTransition: { operationId: member.operationId },
    });

    await runPageHistoryRepair(crowi, { transitions: true });

    expect((await PageHistoryOperation.findById(member._id).lean()).result.status).toBe('succeeded');
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key }).lean()).result.status).toBe('succeeded');
  });

  test('a transient preliminary read failure does not stop sibling workers and remains replayable', async () => {
    const root = await createReadyPage('/subtree/read-error');
    const children: PageDocument[] = [];
    for (let index = 0; index < RENAME_TREE_CONCURRENCY + 1; index += 1) {
      children.push(await createReadyPage(`/subtree/read-error/child-${index}`));
    }
    const key = nextKey();
    const failedChild = children[children.length - 1];
    const findById = Page.findById.bind(Page);
    let injected = false;
    const findSpy = jest.spyOn(Page, 'findById').mockImplementation((pageId, projection, options) => {
      if (!injected && String(pageId) === String(failedChild._id)) {
        injected = true;
        throw new Error('transient member read failure');
      }
      return findById(pageId, projection, options);
    });

    let first: Awaited<ReturnType<typeof run>>;
    try {
      first = await run(root, '/subtree/read-error-moved', key);
    } finally {
      findSpy.mockRestore();
    }

    expect(first.status).toBe('completed');
    expect(first.status === 'completed' && first.failures).toHaveLength(1);
    for (const [index, child] of children.slice(0, -1).entries()) {
      expect(await Page.findById(child._id).lean()).toMatchObject({ path: `/subtree/read-error-moved/child-${index}` });
    }
    expect(await Page.findById(failedChild._id).lean()).toMatchObject({ path: `/subtree/read-error/child-${children.length - 1}` });

    const replay = await run(root, '/subtree/read-error-moved', key);

    expect(replay.status === 'completed' && replay.failures).toEqual([]);
    expect(await Page.findById(root._id).lean()).toMatchObject({ path: '/subtree/read-error-moved' });
    expect(await Page.findById(failedChild._id).lean()).toMatchObject({ path: `/subtree/read-error-moved/child-${children.length - 1}` });
    expect((await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key }).lean()).result.status).toBe('succeeded');
  });

  test('does not move a sealed member whose current path only contains the old prefix later in the string', async () => {
    const root = await createReadyPage('/subtree/prefix');
    const movedAway = await createReadyPage('/subtree/prefix/child');
    const key = nextKey();
    await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `root-${key}`,
      requestFingerprint: `fingerprint-${String(root._id)}-/subtree/new-prefix`,
      memberPageIds: [root._id, movedAway._id],
      groupOperationId: `group-${key}`,
    });
    await Page.updateOne({ _id: movedAway._id }, { $set: { path: '/archive/subtree/prefix/child' } });

    const outcome = await run(root, '/subtree/new-prefix', key);

    expect(outcome.status === 'completed' && outcome.failures).toEqual([
      { oldPath: '/archive/subtree/prefix/child', error: 'Failed to update page (/archive/subtree/prefix/child).' },
    ]);
    expect(await Page.findById(movedAway._id).lean()).toMatchObject({ path: '/archive/subtree/prefix/child' });
  });

  test('the transition repair sweep settles a stranded root after an earlier pass terminalized every member', async () => {
    const root = await createReadyPage('/subtree/repair-terminal-root');
    const child = await createReadyPage('/subtree/repair-terminal-root/child');
    const key = nextKey();
    const { childMember } = await createSealedSubtreeState(root, child, '/subtree/repair-terminal-root-moved', key);
    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });
    await PageHistoryOperation.updateOne({ _id: childMember._id }, { $set: { result: { status: 'failed', completedAt: new Date() } } });

    const repair = await runPageHistoryRepair(crowi, { transitions: true });

    expect(repair.transitions?.reports).toContainEqual({
      operationId: rootOperation.operationId,
      pageId: null,
      path: null,
      action: 'completed',
      reason: 'subtree-root-settled',
    });
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result.status).toBe('succeeded');
  });

  test('the transition repair sweep reports but does not settle a root with no member records', async () => {
    const root = await createReadyPage('/subtree/repair-empty-root');
    const key = nextKey();
    const rootOperation = await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `root-${key}`,
      requestFingerprint: `fingerprint-${String(root._id)}-/subtree/repair-empty-root-moved`,
      memberPageIds: [root._id],
      groupOperationId: `group-${key}`,
    });

    const repair = await runPageHistoryRepair(crowi, { transitions: true });

    expect(repair.transitions?.reports).toContainEqual({
      operationId: rootOperation.operationId,
      pageId: null,
      path: null,
      action: 'blocked',
      reason: 'subtree-root-members-incomplete',
    });
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result).toBeNull();
  });

  test('the repair table resumes a stalled subtree member with the root event grouping id', async () => {
    const root = await createReadyPage('/subtree/repair-member');
    await Page.updateOne({ _id: root._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
    const key = nextKey();
    const first = await run(root, '/subtree/repair-member-moved', key);
    expect(first.status).toBe('completed');
    const rootOperation = await PageHistoryOperation.findOne({ command: 'subtree_rename', idempotencyKey: key });
    const member = await PageHistoryOperation.findOne({ command: 'subtree_rename_member', page: root._id });
    expect(member.result).toBeNull();

    await Page.updateOne({ _id: root._id }, { $set: { pendingHistoryEntry: null } });
    const repair = await runPageHistoryRepair(crowi, { transitions: true });

    expect(repair.transitions?.reports).toContainEqual(
      expect.objectContaining({ operationId: member.operationId, action: 'resumed', reason: 'transition-held-by-operation' }),
    );
    expect(await PageHistoryEvent.countDocuments({ page: root._id, operationId: rootOperation.groupOperationId, kind: 'page_renamed' })).toBe(1);
    expect((await PageHistoryOperation.findById(member._id).lean()).result.status).toBe('succeeded');
    expect((await PageHistoryOperation.findById(rootOperation._id).lean()).result.status).toBe('succeeded');
  });

  test('repair selects the subtree root belonging to the member actor', async () => {
    const page = await createReadyPage('/subtree/repair-actor');
    const key = nextKey();
    const memberKey = deriveMemberKey(key, page._id);
    const wrongRoot = await PageHistoryOperation.create({
      actor: user._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `wrong-root-${key}`,
      requestFingerprint: 'wrong-root-fingerprint',
      memberPageIds: [page._id],
      groupOperationId: `wrong-group-${key}`,
    });
    const rightRoot = await PageHistoryOperation.create({
      actor: otherUser._id,
      command: 'subtree_rename',
      idempotencyKey: key,
      operationId: `right-root-${key}`,
      requestFingerprint: 'right-root-fingerprint',
      memberPageIds: [page._id],
      groupOperationId: `right-group-${key}`,
    });
    const member = await PageHistoryOperation.create({
      actor: otherUser._id,
      command: 'subtree_rename_member',
      idempotencyKey: memberKey,
      operationId: `member-${key}`,
      requestFingerprint: createMemberFingerprint(page._id, page.path, '/subtree/repair-actor-moved'),
      page: page._id,
      fromPath: page.path,
      toPath: '/subtree/repair-actor-moved',
      fromStatus: page.status,
      fromStatusPresent: true,
      toStatus: page.status,
      createRedirect: false,
      source: 'web',
    });
    await Page.updateOne(
      { _id: page._id },
      { $set: { path: '/subtree/repair-actor-moved', status: STATUS_RENAMING, historyTransition: { operationId: member.operationId, kind: 'rename' } } },
    );

    expect(await resumeSubtreeMemberCommand(crowi, member)).toBe('resumed');
    expect(await PageHistoryEvent.countDocuments({ page: page._id, operationId: rightRoot.groupOperationId })).toBe(1);
    expect(await PageHistoryEvent.countDocuments({ page: page._id, operationId: wrongRoot.groupOperationId })).toBe(0);
  });
});

function createMemberFingerprint(pageId: Types.ObjectId, fromPath: string, toPath: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ pageId: String(pageId), fromPath, toPath }))
    .digest('hex');
}
