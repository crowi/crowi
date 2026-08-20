import { Types } from 'mongoose';
import { STATUS_DELETED, STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { restorePageCommand, resumeRestoreCommand } from './restore';

/**
 * RFC-0021 Phase 2c-2a — restore from the trash as a command.
 *
 * The destructive half (removing the stub that occupies the destination) lives
 * in the handler's first-delivery validation, so these tests start from a page
 * already sitting in the trash with a clear destination.
 */
describe('service/page-history/commands/restore (RFC-0021 Phase 2c-2a)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let user;
  let opSeq = 0;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');

    const [testUser] = await Fixture.generate('User', [{ name: 'Restore Tester', username: 'restore-tester', email: 'restore-tester@example.com' }]);
    user = testUser;
  });

  const nextOperationId = () => `restore-op-${opSeq++}`;

  /** A page already in the trash, `ready` for history. */
  async function createTrashedPage(originalPath: string) {
    const page = await Page.create({
      path: originalPath,
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
    await Page.updateOne({ _id: page._id }, { $set: { path: Page.getDeletedPageName(originalPath), status: STATUS_DELETED } });
    return Page.findById(page._id);
  }

  const durableFor = (page, toPath: string, operationId: string) => ({
    fromPath: page.path,
    toPath,
    fromStatus: page.status ?? null,
    fromStatusPresent: page.status != null,
    operationId,
    actor: user._id,
    source: 'web' as const,
  });

  const run = (page, operationId = nextOperationId()) =>
    restorePageCommand(crowi, { page, ...durableFor(page, Page.getRevertDeletedPageName(page.path), operationId) });

  describe('AC-1/AC-2: the page comes back and records one event', () => {
    test('it settles as published with a page_restored carrying both paths', async () => {
      const page = await createTrashedPage('/restore-cmd/ac1');
      const outcome = await run(page);

      expect(outcome.status).toBe('committed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/restore-cmd/ac1');
      expect(raw.status).toBe(STATUS_PUBLISHED);
      expect(raw.historyTransition).toBeNull();

      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_restored' }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ fromPath: '/trash/restore-cmd/ac1', toPath: '/restore-cmd/ac1' });
    });
  });

  describe('AC-3: no stub is left behind in the trash', () => {
    test('the vacated /trash/ path stays empty', async () => {
      const page = await createTrashedPage('/restore-cmd/ac3');
      await run(page);

      // The legacy restore asks for no redirect there, and neither does this.
      expect(await Page.findOne({ path: '/trash/restore-cmd/ac3' })).toBeNull();
    });
  });

  describe('AC-4: the collab lineage is reclaimed after the move lands', () => {
    test('the purge runs once the transition committed, not before', async () => {
      const page = await createTrashedPage('/restore-cmd/ac4');
      const calls: string[] = [];
      const purgeSpy = jest.spyOn(Page, 'purgeCollabLineage').mockImplementation((async () => {
        // By now the page must already be back — the purge is storage
        // reclamation, and the entering CAS's epoch advance is what actually
        // made the pre-delete lineage unreplayable.
        const raw = await Page.collection.findOne({ _id: page._id });
        calls.push(String(raw.status));
      }) as never);

      try {
        await run(page);
      } finally {
        purgeSpy.mockRestore();
      }

      expect(calls).toEqual([STATUS_PUBLISHED]);
    });

    test('a purge failure does not fail the restore', async () => {
      const page = await createTrashedPage('/restore-cmd/ac4-purge-fails');
      const purgeSpy = jest.spyOn(Page, 'purgeCollabLineage').mockImplementation((async () => {
        throw new Error('disk on fire');
      }) as never);

      // The purge only reclaims storage, so its failure must not be reported as
      // a failed restore — the page is already back, and saying otherwise would
      // tell the user it did not come back when it did.
      const outcome = await run(page);
      purgeSpy.mockRestore();
      expect(outcome.status).toBe('committed');

      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_PUBLISHED);
      expect(raw.path).toBe('/restore-cmd/ac4-purge-fails');
    });
  });

  describe('AC-5/AC-6: a stalled restore stays resumable', () => {
    test('AC-5: a failed leaving CAS keeps the page mid-move with its claim', async () => {
      const page = await createTrashedPage('/restore-cmd/ac5');
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });

      const outcome = await run(page);

      expect(outcome.status).toBe('incomplete');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_RENAMING);
      expect(raw.path).toBe('/restore-cmd/ac5');
      expect(raw.historyTransition).not.toBeNull();
    });

    test('AC-6: the repair sweep finishes it and leaves exactly one event', async () => {
      const page = await createTrashedPage('/restore-cmd/ac6');
      const operationId = nextOperationId();
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
      expect((await run(page, operationId)).status).toBe('incomplete');

      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: null } });
      const action = await resumeRestoreCommand(crowi, {
        page: page._id,
        fromPath: '/trash/restore-cmd/ac6',
        toPath: '/restore-cmd/ac6',
        fromStatus: STATUS_DELETED,
        fromStatusPresent: true,
        operationId,
        actor: user._id,
        source: 'web',
        command: 'restore',
      } as never);

      expect(action).toBe('resumed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_PUBLISHED);
      expect(raw.path).toBe('/restore-cmd/ac6');
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_restored' })).toBe(1);
    });
  });
});
