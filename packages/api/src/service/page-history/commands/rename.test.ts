import { Types } from 'mongoose';
import { STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import * as contentSequenceModule from '../content-sequence';
import { renamePageCommand, resumeRenameCommand } from './rename';

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

  /**
   * An untracked page that DOES carry a revision pointer, built via raw
   * writes so the promotion step under test is the only writer that ever
   * touches `historyTracking`/`historySequence` — going through
   * `Page.pushRevision` (like `createReadyPage` above) would promote it
   * before the test even starts. `status` is written explicitly: the schema
   * default only fills a HYDRATED document's gap, but `enterTransition`'s
   * CAS pins the literal `status` value, so a raw doc missing it can never
   * enter a transition at all — unrelated to the promotion logic under test.
   */
  async function createUntrackedPageWithRevision(path: string, body = 'v0') {
    const insertResult = await Page.collection.insertOne({
      path,
      status: STATUS_PUBLISHED,
      grant: Page.GRANT_PUBLIC,
      creator: user._id,
      lastUpdateUser: user._id,
      grantedUsers: [user._id],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const pageId = insertResult.insertedId;
    const revision = await Revision.create({ page: pageId, path, body, format: 'markdown', author: user._id });
    await Page.updateOne({ _id: pageId }, { $set: { revision: revision._id } });
    return Page.findById(pageId);
  }

  /**
   * Intercepts only the `findById` call shaped like the promotion step's own
   * fresh read (`.select('path revision historyTracking')` in `rename.ts`) —
   * every other `findById` the command issues passes through to `exec`
   * untouched. `onMatch` decides what a matching call does; callers that need
   * "only the first match" track that themselves via a closed-over flag,
   * since some callers (AC-7) intentionally want every match counted.
   */
  function spyOnPromotionFreshRead(onMatch: (exec: () => Promise<unknown>) => Promise<unknown>) {
    const findById = Page.findById.bind(Page);
    return jest.spyOn(Page, 'findById').mockImplementation((pageId, projection, options) => {
      const query = findById(pageId, projection, options);
      const exec = query.exec.bind(query);
      query.exec = (async () => {
        const selected = query.projection() as Record<string, unknown> | null;
        if (selected?.path === 1 && selected?.revision === 1 && selected?.historyTracking === 1) {
          return onMatch(exec);
        }
        return exec();
      }) as typeof query.exec;
      return query;
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

  describe('AC-24: subtree rename support leaves the single-page path alone', () => {
    test('omitting the subtree inputs files the event under the transition owner with subtree false', async () => {
      const page = await createReadyPage('/rename/ac24');
      const operationId = nextOperationId();

      const outcome = await renamePageCommand(crowi, {
        page,
        fromPath: page.path,
        toPath: '/rename/ac24-moved',
        fromStatus: page.status ?? null,
        fromStatusPresent: page.status != null,
        operationId,
        actor: user._id,
        user,
        source: 'web',
        createRedirectPage: false,
      });

      expect(outcome.status).toBe('committed');
      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_renamed' }).lean();
      expect(events).toHaveLength(1);
      // The two ids only diverge for a subtree member; every other caller omits
      // `eventOperationId` and must keep the event under the id that owns the
      // transition, since that is what history retrieval groups on.
      expect(events[0].operationId).toBe(operationId);
      expect(events[0].payload.subtree).toBe(false);
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
    test('already-settled is resumed only when the operation event exists', async () => {
      const page = await createReadyPage('/rename/evidence-destination');
      const operationId = nextOperationId();
      const operation = {
        page: page._id,
        fromPath: '/rename/evidence-source',
        toPath: page.path,
        fromStatus: STATUS_PUBLISHED,
        fromStatusPresent: true,
        toStatus: STATUS_PUBLISHED,
        operationId,
        actor: user._id,
        source: 'web',
        command: 'rename',
      } as never;

      expect(await resumeRenameCommand(crowi, operation)).toBe('blocked');
      await PageHistoryEvent.create({
        page: page._id,
        sequence: 99,
        kind: 'page_renamed',
        actor: user._id,
        occurredAt: new Date(),
        operationId,
        source: 'web',
        payload: { fromPath: '/rename/evidence-source', toPath: page.path, redirectCreated: false, subtree: false },
      });
      expect(await resumeRenameCommand(crowi, operation)).toBe('resumed');
    });

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

  describe('feature-rename-promotes-untracked-page: rename promotes an untracked (pointer-carrying) page in place', () => {
    test('AC-2: promotes the page, writes the rename event, and the state becomes ready', async () => {
      const page = await createUntrackedPageWithRevision('/rename/untracked-promote');
      const pointerId = page.revision;

      const outcome = await run(page, '/rename/untracked-promote-moved');

      expect(outcome.status).toBe('committed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/rename/untracked-promote-moved');
      expect(raw.historyTracking.state).toBe('ready');
      expect(raw.historySequence).toBe(2);

      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_renamed' }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].sequence).toBe(2);

      const revision = await Revision.findById(pointerId).lean();
      expect(revision.historySequence).toBe(1);
    });

    test('AC-7: a ready page rename never calls allocateContentSequence and never issues the promotion fresh read', async () => {
      const page = await createReadyPage('/rename/ready-no-promotion');

      const allocateSpy = jest.spyOn(contentSequenceModule, 'allocateContentSequence');
      let promotionFreshReadCalls = 0;
      const findByIdSpy = spyOnPromotionFreshRead(async (exec) => {
        promotionFreshReadCalls += 1;
        return exec();
      });

      let allocateCalls = 0;
      try {
        await run(page, '/rename/ready-no-promotion-moved');
        // Captured BEFORE mockRestore(): restoring a spy resets its own
        // `mock.calls`, so an assertion made after restore would always see
        // zero regardless of what actually happened (see the same trap
        // documented in content-sequence.test.ts's self-heal-exhausted test).
        allocateCalls = allocateSpy.mock.calls.length;
      } finally {
        allocateSpy.mockRestore();
        findByIdSpy.mockRestore();
      }

      expect(allocateCalls).toBe(0);
      expect(promotionFreshReadCalls).toBe(0);
    });

    test('AC-8: a migrating page is never promoted, and its tracking state stays migrating', async () => {
      const page = await createUntrackedPageWithRevision('/rename/migrating');
      await Page.updateOne({ _id: page._id }, { $set: { 'historyTracking.state': 'migrating' } });
      const reloaded = await Page.findById(page._id);

      const allocateSpy = jest.spyOn(contentSequenceModule, 'allocateContentSequence');
      let allocateCalls = 0;
      try {
        await run(reloaded, '/rename/migrating-moved');
        allocateCalls = allocateSpy.mock.calls.length;
      } finally {
        allocateSpy.mockRestore();
      }

      expect(allocateCalls).toBe(0);
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.historyTracking.state).toBe('migrating');
    });

    describe('AC-10: a damaged pointer does not block the move', () => {
      test('the pointer references a Revision that does not exist (dangling)', async () => {
        const page = await createUntrackedPageWithRevision('/rename/dangling');
        await Page.updateOne({ _id: page._id }, { $set: { revision: new Types.ObjectId() } });
        const reloaded = await Page.findById(page._id);

        const allocateSpy = jest.spyOn(contentSequenceModule, 'allocateContentSequence');
        let outcome: Awaited<ReturnType<typeof run>>;
        let allocateCalls = 0;
        try {
          outcome = await run(reloaded, '/rename/dangling-moved');
          allocateCalls = allocateSpy.mock.calls.length;
        } finally {
          allocateSpy.mockRestore();
        }

        expect(outcome.status).toBe('committed');
        expect(allocateCalls).toBe(0);
        const raw = await Page.collection.findOne({ _id: page._id });
        expect(raw.path).toBe('/rename/dangling-moved');
        expect(raw.historyTracking?.state ?? 'untracked').toBe('untracked');
        expect(raw.historySequence ?? 0).toBe(0);
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      });

      test('the pointer references a Revision missing the page field (orphan)', async () => {
        const page = await createUntrackedPageWithRevision('/rename/orphan');
        await Revision.updateOne({ _id: page.revision }, { $unset: { page: '' } });
        const reloaded = await Page.findById(page._id);

        const allocateSpy = jest.spyOn(contentSequenceModule, 'allocateContentSequence');
        let outcome: Awaited<ReturnType<typeof run>>;
        let allocateCalls = 0;
        try {
          outcome = await run(reloaded, '/rename/orphan-moved');
          allocateCalls = allocateSpy.mock.calls.length;
        } finally {
          allocateSpy.mockRestore();
        }

        expect(outcome.status).toBe('committed');
        expect(allocateCalls).toBe(0);
        const raw = await Page.collection.findOne({ _id: page._id });
        expect(raw.path).toBe('/rename/orphan-moved');
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      });

      test('the pointer references a Revision belonging to a different page (foreign)', async () => {
        const page = await createUntrackedPageWithRevision('/rename/foreign');
        const otherPage = await createUntrackedPageWithRevision('/rename/foreign-other');
        await Page.updateOne({ _id: page._id }, { $set: { revision: otherPage.revision } });
        const reloaded = await Page.findById(page._id);

        const allocateSpy = jest.spyOn(contentSequenceModule, 'allocateContentSequence');
        let outcome: Awaited<ReturnType<typeof run>>;
        let allocateCalls = 0;
        try {
          outcome = await run(reloaded, '/rename/foreign-moved');
          allocateCalls = allocateSpy.mock.calls.length;
        } finally {
          allocateSpy.mockRestore();
        }

        expect(outcome.status).toBe('committed');
        expect(allocateCalls).toBe(0);
        const raw = await Page.collection.findOne({ _id: page._id });
        expect(raw.path).toBe('/rename/foreign-moved');
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      });
    });

    test('AC-11: a populated input.page (matching the single-page first-delivery shape) still promotes correctly', async () => {
      const page = await createUntrackedPageWithRevision('/rename/populated');
      const populated = await Page.populatePageData(page, null);

      const outcome = await run(populated, '/rename/populated-moved');

      expect(outcome.status).toBe('committed');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/rename/populated-moved');
      expect(raw.historyTracking.state).toBe('ready');
      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_renamed' }).lean();
      expect(events).toHaveLength(1);
    });

    test('AC-12: an untracked pointer-carrying page already moved to toPath is resumed via the already-settled fallback, without being promoted', async () => {
      const page = await createUntrackedPageWithRevision('/rename/resume-source');
      const operationId = nextOperationId();
      await Page.updateOne({ _id: page._id }, { $set: { path: '/rename/resume-dest' } });

      const operation = {
        page: page._id,
        fromPath: '/rename/resume-source',
        toPath: '/rename/resume-dest',
        fromStatus: STATUS_PUBLISHED,
        fromStatusPresent: true,
        toStatus: STATUS_PUBLISHED,
        operationId,
        actor: user._id,
        source: 'web',
        command: 'rename',
      } as never;

      const allocateSpy = jest.spyOn(contentSequenceModule, 'allocateContentSequence');
      let action: Awaited<ReturnType<typeof resumeRenameCommand>>;
      let allocateCalls = 0;
      try {
        action = await resumeRenameCommand(crowi, operation);
        allocateCalls = allocateSpy.mock.calls.length;
      } finally {
        allocateSpy.mockRestore();
      }

      expect(action).toBe('resumed');
      expect(allocateCalls).toBe(0);
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.historyTracking?.state ?? 'untracked').toBe('untracked');
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    test('AC-13: allocated but not materialized reports contended and does not move the page', async () => {
      const page = await createUntrackedPageWithRevision('/rename/materialize-fails');

      const allocateSpy = jest
        .spyOn(contentSequenceModule, 'allocateContentSequence')
        .mockResolvedValueOnce({ allocated: true, sequence: 1, materialized: false, alreadySequenced: false });
      let outcome: Awaited<ReturnType<typeof run>>;
      try {
        outcome = await run(page, '/rename/materialize-fails-moved');
      } finally {
        allocateSpy.mockRestore();
      }

      expect(outcome.status).toBe('contended');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/rename/materialize-fails');
      expect(raw.historyTransition).toBeUndefined(); // never entered -- the promotion step returned before runPageTransition ran
    });

    test('AC-14: the promotion fresh read finding no page reports page-missing', async () => {
      const page = await createUntrackedPageWithRevision('/rename/fresh-read-missing');
      let intercepted = false;
      const findByIdSpy = spyOnPromotionFreshRead(async (exec) => {
        if (intercepted) return exec();
        intercepted = true;
        return null;
      });

      let outcome: Awaited<ReturnType<typeof run>>;
      try {
        outcome = await run(page, '/rename/fresh-read-missing-moved');
      } finally {
        findByIdSpy.mockRestore();
      }

      expect(outcome).toMatchObject({ status: 'page-missing' });
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/rename/fresh-read-missing');
    });

    test('AC-15: an exception in the promotion fresh read reports contended, and the page is not moved', async () => {
      const page = await createUntrackedPageWithRevision('/rename/fresh-read-throws');
      let intercepted = false;
      const findByIdSpy = spyOnPromotionFreshRead(async (exec) => {
        if (intercepted) return exec();
        intercepted = true;
        throw new Error('injected fresh-read failure');
      });

      let outcome: Awaited<ReturnType<typeof run>>;
      try {
        outcome = await run(page, '/rename/fresh-read-throws-moved');
      } finally {
        findByIdSpy.mockRestore();
      }

      expect(outcome.status).toBe('contended');
      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/rename/fresh-read-throws');
      expect(raw.historyTransition).toBeUndefined(); // never entered -- the promotion step returned before runPageTransition ran
    });

    describe('AC-16: pointer ownership checks out, but the allocator itself will not promote', () => {
      test('(a) a degraded page (historyTracking stripped, pointer already sequenced) moves without re-promoting', async () => {
        const page = await createReadyPage('/rename/degraded-sequenced');
        const beforeSequence = (await Page.collection.findOne({ _id: page._id })).historySequence;
        await Page.updateOne({ _id: page._id }, { $unset: { historyTracking: '' } });
        const reloaded = await Page.findById(page._id);

        const outcome = await run(reloaded, '/rename/degraded-sequenced-moved');

        expect(outcome.status).toBe('committed');
        const raw = await Page.collection.findOne({ _id: page._id });
        expect(raw.path).toBe('/rename/degraded-sequenced-moved');
        expect(raw.historyTracking).toBeUndefined();
        expect(raw.historySequence).toBe(beforeSequence);
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      });

      test('(b) a page with historySequence explicitly null moves without being promoted', async () => {
        const page = await createUntrackedPageWithRevision('/rename/null-sequence');
        await Page.updateOne({ _id: page._id }, { $set: { historySequence: null } });
        const reloaded = await Page.findById(page._id);

        const outcome = await run(reloaded, '/rename/null-sequence-moved');

        expect(outcome.status).toBe('committed');
        const raw = await Page.collection.findOne({ _id: page._id });
        expect(raw.path).toBe('/rename/null-sequence-moved');
        expect(raw.historyTracking?.state ?? 'untracked').toBe('untracked');
        expect(raw.historySequence).toBeNull();
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      });

      test('(c) a page whose own outbox is occupied moves without being promoted, and the outbox stays occupied', async () => {
        const page = await createUntrackedPageWithRevision('/rename/outbox-occupied');
        await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
        const reloaded = await Page.findById(page._id);

        const outcome = await run(reloaded, '/rename/outbox-occupied-moved');

        expect(outcome.status).toBe('committed');
        const raw = await Page.collection.findOne({ _id: page._id });
        expect(raw.path).toBe('/rename/outbox-occupied-moved');
        expect(raw.historyTracking?.state ?? 'untracked').toBe('untracked');
        expect(raw.pendingHistoryEntry).toBeDefined();
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      });
    });
  });
});
