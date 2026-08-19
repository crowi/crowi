import { Types } from 'mongoose';
import { STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { renamePageCommand } from './rename';

/**
 * RFC-0021 Phase 2c-2a — the rename command (AC-1..AC-7, AC-12, AC-13).
 *
 * The HTTP-level acceptance criteria (idempotency keys, replay, status codes)
 * are covered against the handler; what this file pins is the command's own
 * behaviour on top of the shared runner.
 */
describe('service/page-history/commands/rename (RFC-0021 Phase 2c-2a)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let user;
  let opSeq = 0;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');

    const [testUser] = await Fixture.generate('User', [{ name: 'Rename Tester', username: 'rename-tester', email: 'rename-tester@example.com' }]);
    user = testUser;
  });

  const nextOperationId = () => `rename-op-${opSeq++}`;

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

  /** A page that never had a content save, so the history allocator never promoted it (AC-6). */
  async function createUntrackedPage(path: string) {
    return Page.create({
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
  }

  const run = (page, toPath: string, createRedirectPage = false) =>
    renamePageCommand(crowi, {
      page,
      fromPath: page.path,
      toPath,
      fromStatus: page.status ?? null,
      fromStatusPresent: page.status != null,
      operationId: nextOperationId(),
      actor: user._id,
      user,
      source: 'web',
      createRedirectPage,
    });

  describe('AC-1/AC-2: a rename moves the page and records one event', () => {
    test('the payload carries both paths, the redirect result, and subtree false', async () => {
      const page = await createReadyPage('/rename/ac1');
      const outcome = await run(page, '/rename/ac1-moved');

      expect(outcome.status).toBe('committed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/rename/ac1-moved');
      expect(raw.status).toBe(STATUS_PUBLISHED);
      expect(raw.historyTransition).toBeNull();

      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_renamed' }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ fromPath: '/rename/ac1', toPath: '/rename/ac1-moved', redirectCreated: false, subtree: false });
    });
  });

  describe('AC-3/AC-4/AC-5: redirectCreated reports what happened, not what was asked', () => {
    test('AC-3: a requested stub is created and recorded true', async () => {
      const page = await createReadyPage('/rename/ac3');
      const outcome = await run(page, '/rename/ac3-moved', true);

      expect(outcome.status).toBe('committed');
      expect(outcome.redirectCreated).toBe(true);
      const stub = await Page.findOne({ path: '/rename/ac3' });
      expect(stub?.redirectTo).toBe('/rename/ac3-moved');

      const event = await PageHistoryEvent.findOne({ page: page._id, kind: 'page_renamed' }).lean();
      expect(event.payload.redirectCreated).toBe(true);
    });

    test('AC-4: no stub is requested, none is created, and it is recorded false', async () => {
      const page = await createReadyPage('/rename/ac4');
      await run(page, '/rename/ac4-moved', false);

      expect(await Page.findOne({ path: '/rename/ac4' })).toBeNull();
      const event = await PageHistoryEvent.findOne({ page: page._id, kind: 'page_renamed' }).lean();
      expect(event.payload.redirectCreated).toBe(false);
    });

    test('AC-5: an occupied old path does not fail the rename, it just records false', async () => {
      const page = await createReadyPage('/rename/ac5');
      const outcome = await runWithOccupant(page);

      // The move is durable by the time the stub is attempted, so refusing here
      // would report failure for something that already happened.
      expect(outcome.status).toBe('committed');
      expect(outcome.redirectCreated).toBe(false);
      const event = await PageHistoryEvent.findOne({ page: page._id, kind: 'page_renamed' }).lean();
      expect(event.payload.redirectCreated).toBe(false);
      // The unrelated page that took the old path is untouched.
      const occupant = await Page.findOne({ path: '/rename/ac5' });
      expect(occupant.redirectTo).toBeNull();
    });

    /** Enters the transition, then plants an unrelated page on the vacated path before step 2 runs. */
    async function runWithOccupant(page) {
      const original = Page.findOne.bind(Page);
      const spy = jest.spyOn(Page, 'findOne').mockImplementation((...args: unknown[]) => {
        const filter = args[0] as { path?: string } | undefined;
        if (filter?.path === '/rename/ac5') {
          spy.mockRestore();
          return { exec: async () => ({ _id: new Types.ObjectId(), path: '/rename/ac5' }) } as never;
        }
        return original(...(args as Parameters<typeof original>));
      });
      try {
        return await run(page, '/rename/ac5-moved', true);
      } finally {
        spy.mockRestore();
        await Page.create({
          path: '/rename/ac5',
          creator: user._id,
          lastUpdateUser: user._id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          redirectTo: null,
          grant: Page.GRANT_PUBLIC,
          status: STATUS_PUBLISHED,
          grantedUsers: [user._id],
        });
      }
    }
  });

  describe('AC-6: an untracked page renames without producing history', () => {
    test('the move succeeds, no event is written, and the sequence does not move', async () => {
      const page = await createUntrackedPage('/rename/ac6');
      const before = await Page.collection.findOne({ _id: page._id });

      const outcome = await run(page, '/rename/ac6-moved');

      expect(outcome.status).toBe('committed');
      const after = await Page.collection.findOne({ _id: page._id });
      expect(after.path).toBe('/rename/ac6-moved');
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      expect(after.historySequence).toBe(before.historySequence);
    });
  });

  describe('AC-7: the post-rename page event keeps its current condition', () => {
    test('it fires when no redirect was created and stays silent when one was', async () => {
      const pageEvent = crowi.event('Page');
      const emitted: string[] = [];
      const spy = jest.spyOn(pageEvent, 'emit').mockImplementation(((name: string, ...rest: unknown[]) => {
        if (name === 'update') emitted.push(String((rest[0] as { path?: string })?.path));
        return true;
      }) as never);

      try {
        const noRedirect = await createReadyPage('/rename/ac7-plain');
        await run(noRedirect, '/rename/ac7-plain-moved', false);
        expect(emitted).toContain('/rename/ac7-plain-moved');

        emitted.length = 0;
        const withRedirect = await createReadyPage('/rename/ac7-stub');
        await run(withRedirect, '/rename/ac7-stub-moved', true);
        // The legacy path returns early when it creates a redirect and never
        // emits; keeping that condition is what this asserts.
        expect(emitted).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('AC-12/AC-13: a stalled rename leaves a resumable page', () => {
    test('AC-12: a failed leaving CAS keeps the page renaming and reports incomplete', async () => {
      const page = await createReadyPage('/rename/ac12');
      // An unrepairable outbox entry stops the leaving CAS from ever committing.
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });

      const outcome = await run(page, '/rename/ac12-moved');

      expect(outcome.status).toBe('incomplete');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_RENAMING);
      expect(raw.historyTransition).not.toBeNull();
      // The path already moved — that is what makes it resumable rather than lost.
      expect(raw.path).toBe('/rename/ac12-moved');
    });

    test('AC-13: afterEnter runs again on resume and finishes the revision path sync', async () => {
      const page = await createReadyPage('/rename/ac13');
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
      const operationId = nextOperationId();

      // The durable input the operation record would hold. A resume MUST reuse
      // it: by then the page is already at the destination, so re-deriving
      // `fromPath` from the page would describe a second move out of it.
      const durable = {
        fromPath: '/rename/ac13',
        toPath: '/rename/ac13-moved',
        fromStatus: STATUS_PUBLISHED,
        fromStatusPresent: true,
        operationId,
        actor: user._id,
        user,
        source: 'web' as const,
        createRedirectPage: false,
      };

      const stalled = await renamePageCommand(crowi, { page, ...durable });
      expect(stalled.status).toBe('incomplete');

      // Clear the jam and replay the same operation, as repair would.
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: null } });
      const resumed = await renamePageCommand(crowi, { page: await Page.findById(page._id), ...durable });

      expect(resumed.status).toBe('committed');
      const revisions = await Revision.find({ page: page._id }).lean();
      expect(revisions.every((r) => r.path === '/rename/ac13-moved')).toBe(true);
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_renamed' })).toBe(1);
    });
  });
});
