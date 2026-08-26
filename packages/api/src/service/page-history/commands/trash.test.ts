import { Types } from 'mongoose';
import { STATUS_DELETED, STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { resumeTrashCommand, trashPageCommand } from './trash';

/**
 * RFC-0021 Phase 2c-2a — soft delete as a command (AC-1..AC-7).
 *
 * The HTTP-level criteria live against the handler; this file pins the
 * command's own behaviour, and in particular the ordering the legacy delete
 * documented and this one has to preserve.
 */
describe('service/page-history/commands/trash (RFC-0021 Phase 2c-2a)', () => {
  let Page;
  let Revision;
  let Share;
  let PageHistoryEvent;
  let user;
  let opSeq = 0;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    Share = crowi.model('Share');
    PageHistoryEvent = crowi.model('PageHistoryEvent');

    const [testUser] = await Fixture.generate('User', [{ name: 'Trash Tester', username: 'trash-tester', email: 'trash-tester@example.com' }]);
    user = testUser;
  });

  const nextOperationId = () => `trash-op-${opSeq++}`;

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

  /** The durable input the operation record holds. A resume must reuse it verbatim — the page has already moved by then. */
  const durableFor = (page, operationId: string) => ({
    fromPath: page.path,
    toPath: Page.getDeletedPageName(page.path),
    fromStatus: page.status ?? null,
    fromStatusPresent: page.status != null,
    operationId,
    actor: user._id,
    user,
    source: 'web' as const,
  });

  const run = (page, operationId = nextOperationId()) => trashPageCommand(crowi, { page, ...durableFor(page, operationId) });

  describe('AC-1/AC-2: the page moves to /trash/ and records one event', () => {
    test('it settles as deleted with a page_trashed carrying both paths', async () => {
      const page = await createReadyPage('/trash-cmd/ac1');
      const outcome = await run(page);

      expect(outcome.status).toBe('committed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/trash/trash-cmd/ac1');
      expect(raw.status).toBe(STATUS_DELETED);
      expect(raw.historyTransition).toBeNull();

      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_trashed' }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ fromPath: '/trash-cmd/ac1', toPath: '/trash/trash-cmd/ac1' });
    });
  });

  describe('AC-3: a redirect stub is left at the vacated path', () => {
    test('links to the deleted page keep resolving', async () => {
      const page = await createReadyPage('/trash-cmd/ac3');
      const outcome = await run(page);

      expect(outcome.redirectCreated).toBe(true);
      const stub = await Page.findOne({ path: '/trash-cmd/ac3' });
      expect(stub?.redirectTo).toBe('/trash/trash-cmd/ac3');
    });
  });

  describe('AC-4: the collab side is torn down', () => {
    test('the reload prompt and the lineage purge run before anything that can throw', async () => {
      const page = await createReadyPage('/trash-cmd/ac4');
      const order: string[] = [];
      const invalidateSpy = jest.spyOn(Page, 'invalidateLiveCollabDoc').mockImplementation((() => {
        order.push('invalidate');
      }) as never);
      const purgeSpy = jest.spyOn(Page, 'purgeCollabLineage').mockImplementation((async () => {
        order.push('purge');
      }) as never);
      const shareSpy = jest.spyOn(Share, 'deleteByPageId').mockImplementation((async () => {
        order.push('share');
        return null;
      }) as never);

      try {
        await run(page);
      } finally {
        invalidateSpy.mockRestore();
        purgeSpy.mockRestore();
        shareSpy.mockRestore();
      }

      // The legacy delete documented why: anything after these two can throw,
      // and a prompt that never fired leaves an editor attached to a page the
      // user just deleted, while an unpurged yjsState keeps the deleted
      // content readable from the append log.
      expect(order).toEqual(['invalidate', 'purge', 'share']);
    });

    test('the share link stops working', async () => {
      const page = await createReadyPage('/trash-cmd/ac4-share');
      await Share.create({ uuid: `share-${page._id}`, page: page._id, creator: user._id });
      expect(await Share.countDocuments({ page: page._id, status: Share.STATUS_ACTIVE })).toBe(1);

      await run(page);

      // `deleteByPageId` retires the share rather than removing the row, so
      // the assertion is on it no longer being active.
      expect(await Share.countDocuments({ page: page._id, status: Share.STATUS_ACTIVE })).toBe(0);
    });
  });

  describe('AC-5/AC-6: a stalled trash stays resumable', () => {
    test('AC-5: a failed leaving CAS keeps the page mid-move with its claim', async () => {
      const page = await createReadyPage('/trash-cmd/ac5');
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });

      const outcome = await run(page);

      expect(outcome.status).toBe('incomplete');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_RENAMING);
      expect(raw.path).toBe('/trash/trash-cmd/ac5');
      expect(raw.historyTransition).not.toBeNull();
    });

    test('AC-6: resuming re-runs the teardown, so a share left behind by an interrupted run is still removed', async () => {
      const page = await createReadyPage('/trash-cmd/ac6');
      await Share.create({ uuid: `share-${page._id}`, page: page._id, creator: user._id });
      const operationId = nextOperationId();

      // Interrupt after the lineage purge and before the share cleanup.
      const durable = durableFor(page, operationId);
      const shareSpy = jest.spyOn(Share, 'deleteByPageId').mockImplementationOnce((() => {
        throw new Error('interrupted');
      }) as never);
      await expect(trashPageCommand(crowi, { page, ...durable })).rejects.toThrow('interrupted');
      shareSpy.mockRestore();

      expect(await Share.countDocuments({ page: page._id, status: Share.STATUS_ACTIVE })).toBe(1);

      const resumed = await trashPageCommand(crowi, { page: await Page.findById(page._id), ...durable });

      expect(resumed.status).toBe('committed');
      expect(await Share.countDocuments({ page: page._id, status: Share.STATUS_ACTIVE })).toBe(0);
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_trashed' })).toBe(1);
    });
  });

  describe('AC-7: the repair sweep can finish a stalled trash', () => {
    test('already-settled is resumed only when the operation event exists', async () => {
      const page = await createReadyPage('/trash-cmd/evidence-source');
      const operationId = nextOperationId();
      const toPath = '/trash/trash-cmd/evidence-source';
      await Page.updateOne({ _id: page._id }, { $set: { path: toPath, status: STATUS_DELETED } });
      const operation = {
        page: page._id,
        fromPath: page.path,
        toPath,
        fromStatus: STATUS_PUBLISHED,
        fromStatusPresent: true,
        toStatus: STATUS_DELETED,
        operationId,
        actor: user._id,
        source: 'web',
        command: 'trash',
      } as never;

      expect(await resumeTrashCommand(crowi, operation)).toBe('blocked');
      await PageHistoryEvent.create({
        page: page._id,
        sequence: 99,
        kind: 'page_trashed',
        actor: user._id,
        occurredAt: new Date(),
        operationId,
        source: 'web',
        payload: { fromPath: page.path, toPath },
      });
      expect(await resumeTrashCommand(crowi, operation)).toBe('resumed');
    });

    test('resumeTrashCommand lands it and leaves exactly one event', async () => {
      const page = await createReadyPage('/trash-cmd/ac7');
      const operationId = nextOperationId();
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
      expect((await run(page, operationId)).status).toBe('incomplete');

      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: null } });
      const action = await resumeTrashCommand(crowi, {
        page: page._id,
        fromPath: '/trash-cmd/ac7',
        toPath: '/trash/trash-cmd/ac7',
        fromStatus: STATUS_PUBLISHED,
        fromStatusPresent: true,
        operationId,
        actor: user._id,
        source: 'web',
        command: 'trash',
      } as never);

      expect(action).toBe('resumed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_DELETED);
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_trashed' })).toBe(1);
    });
  });
});
