import { Types } from 'mongoose';
import { STATUS_PUBLISHED, STATUS_RENAMING } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { classifyResume, enterTransition, runPageTransition } from './transition';
import type { PageTransitionInput } from './transition';

/**
 * RFC-0021 Phase 2c-2a — the shared path-move runner (AC-9..AC-19).
 *
 * AC-17 and AC-19 are split across phases: this file pins the runner's half
 * (a resumed execution reports `already-settled` without appending a second
 * event; a vanished Page reports `page-missing`). Terminating the operation
 * record — `completeOperation` with `succeeded` — belongs to the operation
 * service and is covered there.
 */
describe('service/page-history/transition — runPageTransition (RFC-0021 Phase 2c-2a)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let user;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');

    const [testUser] = await Fixture.generate('User', [{ name: 'Transition Tester', username: 'transition-tester', email: 'transition-tester@example.com' }]);
    user = testUser;
  });

  /** A `ready` page: a real `pushRevision` promotes `historyTracking` via the Phase 2a allocator, which the leaving CAS needs to append its event. */
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

  function inputFor(pageId: Types.ObjectId, fromPath: string, toPath: string, overrides: Partial<PageTransitionInput> = {}): PageTransitionInput {
    return {
      pageId,
      operationId: `op-${toPath}`,
      kind: 'rename',
      fromPath,
      toPath,
      fromStatus: STATUS_PUBLISHED,
      fromStatusPresent: true,
      toStatus: STATUS_PUBLISHED,
      actor: user._id,
      source: 'web',
      // The runner is payload-agnostic; the kind's own schema decides the
      // field set, and `page_renamed` requires all four.
      event: { kind: 'page_renamed', payload: { fromPath, toPath, redirectCreated: false, subtree: false } },
      ...overrides,
    };
  }

  describe('AC-9: the entering CAS is the mutual exclusion', () => {
    test('a second operation cannot enter a page that is already mid-transition', async () => {
      const page = await createReadyPage('/transition/ac9');
      const first = await enterTransition(crowi, inputFor(page._id, '/transition/ac9', '/transition/ac9-moved'));
      expect(first).not.toBeNull();

      // The loser pins `historyTransition: null`, which no longer matches.
      const second = await enterTransition(crowi, {
        ...inputFor(page._id, '/transition/ac9-moved', '/transition/ac9-other'),
        operationId: 'op-other',
      });
      expect(second).toBeNull();

      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.historyTransition.operationId).toBe('op-/transition/ac9-moved');
    });
  });

  describe('AC-33: entering advances the collab lifecycle epoch', () => {
    test('the epoch moves in the same write as the path, not a separate one', async () => {
      const page = await createReadyPage('/transition/ac33');
      const before = await Page.collection.findOne({ _id: page._id });

      await enterTransition(crowi, inputFor(page._id, '/transition/ac33', '/transition/ac33-moved'));

      // An editor attached to the old path is only forced off by this epoch.
      // A page whose path moved while its epoch stood still would keep that
      // editor live on a document that no longer exists at that path.
      const after = await Page.collection.findOne({ _id: page._id });
      expect(after.collabLifecycleVersion).toBe(before.collabLifecycleVersion + 1);
      expect(after.path).toBe('/transition/ac33-moved');
    });
  });

  describe('AC-10: a legacy page with no status field can still enter', () => {
    test('the CAS pins $exists:false instead of a value', async () => {
      const page = await createReadyPage('/transition/ac10');
      await Page.collection.updateOne({ _id: page._id }, { $unset: { status: '' } });

      const entered = await enterTransition(crowi, {
        ...inputFor(page._id, '/transition/ac10', '/transition/ac10-moved'),
        fromStatus: null,
        fromStatusPresent: false,
      });

      expect(entered).not.toBeNull();
      expect(entered.status).toBe(STATUS_RENAMING);
    });

    test('pinning a value against a status-less page does not match', async () => {
      const page = await createReadyPage('/transition/ac10-mismatch');
      await Page.collection.updateOne({ _id: page._id }, { $unset: { status: '' } });

      // `fromStatusPresent: true` pins `status: 'published'`; the field is gone.
      const entered = await enterTransition(crowi, inputFor(page._id, '/transition/ac10-mismatch', '/transition/ac10-mismatch-moved'));
      expect(entered).toBeNull();
    });
  });

  describe('AC-11/AC-12: the leaving CAS settles the page and appends the event', () => {
    test('it restores the status, clears the transition, and stamps the operation id on the event', async () => {
      const page = await createReadyPage('/transition/ac11');
      const outcome = await runPageTransition(crowi, inputFor(page._id, '/transition/ac11', '/transition/ac11-moved'));

      expect(outcome.status).toBe('committed');

      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.path).toBe('/transition/ac11-moved');
      expect(raw.status).toBe(STATUS_PUBLISHED);
      expect(raw.historyTransition).toBeNull();

      const events = await PageHistoryEvent.find({ page: page._id, kind: 'page_renamed' }).lean();
      expect(events).toHaveLength(1);
      // AC-12: the operation's id, not one minted per attempt.
      expect(events[0].operationId).toBe('op-/transition/ac11-moved');
      expect(events[0].payload).toEqual({
        fromPath: '/transition/ac11',
        toPath: '/transition/ac11-moved',
        redirectCreated: false,
        subtree: false,
      });
    });
  });

  describe('AC-13: a failed leaving CAS leaves the page mid-transition', () => {
    test('the page keeps renaming and its claim so an operator can finish it', async () => {
      const page = await createReadyPage('/transition/ac13');
      const input = inputFor(page._id, '/transition/ac13', '/transition/ac13-moved');

      // A malformed outbox entry can never be drained, so the 2c-1 command
      // exhausts its budget and never commits.
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });

      const outcome = await runPageTransition(crowi, input);
      expect(outcome.status).toBe('incomplete');

      const raw = await Page.collection.findOne({ _id: page._id });
      expect(raw.status).toBe(STATUS_RENAMING);
      expect(raw.historyTransition.operationId).toBe(input.operationId);
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_renamed' })).toBe(0);
    });
  });

  describe('AC-14: readers skip a page mid-transition', () => {
    test('none of the five named readers returns it', async () => {
      const page = await createReadyPage('/transition/ac14');
      await enterTransition(crowi, inputFor(page._id, '/transition/ac14', '/transition/ac14-moved'));

      await expect(Page.findPageByIdAndGrantedUser(page._id, user)).rejects.toThrow();
      await expect(Page.findPage('/transition/ac14-moved', user, null, true)).resolves.toBeNull();
      expect(await Page.findListByPageIds([page._id])).toHaveLength(0);
      expect(await Page.findPagesByIds([page._id])).toHaveLength(0);

      const streamed: string[] = [];
      for await (const doc of Page.getStreamOfFindAll({ publicOnly: false })) {
        streamed.push(String(doc._id));
      }
      expect(streamed).not.toContain(String(page._id));
    });

    test('a settled page is visible to those readers again', async () => {
      const page = await createReadyPage('/transition/ac14-settle');
      const outcome = await runPageTransition(crowi, inputFor(page._id, '/transition/ac14-settle', '/transition/ac14-settled'));
      expect(outcome.status).toBe('committed');

      await expect(Page.findPageByIdAndGrantedUser(page._id, user)).resolves.toBeTruthy();
      expect(await Page.findPagesByIds([page._id])).toHaveLength(1);
    });
  });

  describe('AC-16: a resumed execution skips the entering CAS', () => {
    test('it re-runs afterEnter and settles without a second entry', async () => {
      const page = await createReadyPage('/transition/ac16');
      const input = inputFor(page._id, '/transition/ac16', '/transition/ac16-moved');

      // Stand where a crash between step 1 and step 3 would have left us.
      await enterTransition(crowi, input);

      let afterEnterCalls = 0;
      let settleCalls = 0;
      const outcome = await runPageTransition(crowi, {
        ...input,
        afterEnter: async () => {
          afterEnterCalls += 1;
        },
        settleVacatedPath: async () => {
          settleCalls += 1;
        },
      });

      expect(outcome.status).toBe('committed');
      expect(afterEnterCalls).toBe(1);
      expect(settleCalls).toBe(1);
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_renamed' })).toBe(1);
    });
  });

  describe('AC-17: an execution that finds the move already landed does not repeat it', () => {
    test('it reports already-settled and appends no second event', async () => {
      const page = await createReadyPage('/transition/ac17');
      const input = inputFor(page._id, '/transition/ac17', '/transition/ac17-moved');
      expect((await runPageTransition(crowi, input)).status).toBe('committed');

      const second = await runPageTransition(crowi, input);

      expect(second.status).toBe('already-settled');
      expect(await PageHistoryEvent.countDocuments({ page: page._id, kind: 'page_renamed' })).toBe(1);
    });
  });

  describe('AC-18: another operation owning the transition is refused', () => {
    test('it reports the owner and writes nothing', async () => {
      const page = await createReadyPage('/transition/ac18');
      await enterTransition(crowi, inputFor(page._id, '/transition/ac18', '/transition/ac18-moved'));
      const before = await Page.collection.findOne({ _id: page._id });

      const outcome = await runPageTransition(crowi, {
        ...inputFor(page._id, '/transition/ac18-moved', '/transition/ac18-elsewhere'),
        operationId: 'op-intruder',
      });

      expect(outcome).toEqual({ status: 'owned-elsewhere', ownerOperationId: 'op-/transition/ac18-moved' });
      const after = await Page.collection.findOne({ _id: page._id });
      expect(after.path).toBe(before.path);
      expect(after.status).toBe(before.status);
      expect(after.historyTransition.operationId).toBe(before.historyTransition.operationId);
    });
  });

  describe('AC-19: a vanished page is reported rather than resurrected', () => {
    test('runPageTransition reports page-missing', async () => {
      const page = await createReadyPage('/transition/ac19');
      const input = inputFor(page._id, '/transition/ac19', '/transition/ac19-moved');
      await Page.collection.deleteOne({ _id: page._id });

      expect(await runPageTransition(crowi, input)).toEqual({ status: 'page-missing' });
    });
  });

  describe('classifyResume', () => {
    const expectation = {
      operationId: 'op-1',
      fromPath: '/a',
      toPath: '/b',
      fromStatus: STATUS_PUBLISHED,
      fromStatusPresent: true,
      toStatus: STATUS_PUBLISHED,
    };

    test('reads every branch of the resume table', () => {
      expect(classifyResume(null, expectation)).toEqual({ decision: 'page-missing' });
      expect(classifyResume({ historyTransition: { operationId: 'op-1' } }, expectation)).toEqual({ decision: 'resume-own' });
      expect(classifyResume({ historyTransition: { operationId: 'op-2' } }, expectation)).toEqual({
        decision: 'owned-elsewhere',
        ownerOperationId: 'op-2',
      });
      expect(classifyResume({ path: '/b', status: STATUS_PUBLISHED, historyTransition: null }, expectation)).toEqual({ decision: 'already-settled' });
      expect(classifyResume({ path: '/a', status: STATUS_PUBLISHED, historyTransition: null }, expectation)).toEqual({ decision: 'not-entered' });
      expect(classifyResume({ path: '/somewhere-else', historyTransition: null }, expectation)).toEqual({ decision: 'indeterminate' });
    });

    test('a missing status counts as not-entered only when the command recorded it missing', () => {
      const legacy = { ...expectation, fromStatus: null, fromStatusPresent: false };
      expect(classifyResume({ path: '/a', historyTransition: null }, legacy)).toEqual({ decision: 'not-entered' });
      // The command recorded a value, so a status-less page is not the state it left.
      expect(classifyResume({ path: '/a', historyTransition: null }, expectation)).toEqual({ decision: 'indeterminate' });
    });
  });
});
