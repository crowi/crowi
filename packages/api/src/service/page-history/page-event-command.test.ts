import { Types } from 'mongoose';
import { STATUS_DRAFT, STATUS_PUBLISHED } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { publishDraftPage } from './commands/publish-draft';
import { changePageVisibility } from './commands/visibility';
import * as contentSequenceModule from './content-sequence';
import * as materializeModule from './materialize';
import { runPageEventCommand } from './page-event-command';
import type { PageCommandPlan } from './page-event-command';
import { repairPendingEntries, scanUnsequencedRevisions } from './repair';

/**
 * RFC-0021 §6.2/§6.3 (Phase 2c-1) — `runPageEventCommand`/`changePageVisibility`/
 * `publishDraftPage` coverage: the shared CAS-and-event skeleton
 * (AC-1/2/3/4/6/7/14/15/16/19/20), `Page.updatePage`'s body+grant integration
 * (AC-5), and draft publish (AC-8/9/10/25). Collab-side wiring (AC-17/18) is
 * covered in `packages/collab`.
 */
describe('service/page-history/page-event-command — runPageEventCommand / changePageVisibility (RFC-0021 Phase 2c-1)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let PageHistoryOperation;
  let user;
  let otherUser;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    PageHistoryOperation = crowi.model('PageHistoryOperation');

    const [testUser, testOtherUser] = await Fixture.generate('User', [
      { name: 'Page Event Command Tester', username: 'page-event-command-tester', email: 'page-event-command-tester@example.com' },
      { name: 'Page Event Command Other', username: 'page-event-command-other', email: 'page-event-command-other@example.com' },
    ]);
    user = testUser;
    otherUser = testOtherUser;
  });

  /** A Phase-1-era shape: no `pushRevision` ever ran, so `historyTracking.state` reads back `untracked` (schema default on a raw `.create()`). */
  async function createUntrackedPage(path: string, grant = Page.GRANT_PUBLIC, status = STATUS_PUBLISHED) {
    return Page.create({
      path,
      creator: user._id,
      lastUpdateUser: user._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      redirectTo: null,
      grant,
      status,
      grantedUsers: [user._id],
    });
  }

  /** A malformed `page_event` outbox entry (no `event`) — `materializePendingEntry` throws on it every time (`assertWellFormedPendingEntry`), so drain-assist can never clear it. Reliably exhausts the drain-assist budget without needing to mock anything. */
  async function stageJammedOutbox(pageId: Types.ObjectId) {
    await Page.updateOne({ _id: pageId }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
  }

  /** Same Phase-1-era shape as `createUntrackedPage`, but `status: STATUS_DRAFT` — no `pushRevision` ever ran, so no seed Revision and no content-sequence promotion (AC-25). */
  async function createUntrackedDraftPage(path: string) {
    return createUntrackedPage(path, Page.GRANT_PUBLIC, STATUS_DRAFT);
  }

  /** A `ready` draft — mirrors `draft.ts`'s create-draft handler (`Page.create` + a seed `pushRevision`, which promotes via `allocateContentSequence`, Phase 2a). */
  async function createReadyDraftPage(path: string) {
    const draft = await createUntrackedPage(path, Page.GRANT_PUBLIC, STATUS_DRAFT);
    const seedRevision = await Revision.prepareRevision(draft, 'seed body', user, { format: 'markdown' });
    await Page.pushRevision(draft, seedRevision, user);
    return draft;
  }

  function createGrantChangePlan(toGrant: number): PageCommandPlan {
    return (snapshot) => {
      if (typeof snapshot.grant !== 'number') {
        return { decision: 'reject', reason: 'missing-grant' };
      }

      return {
        decision: 'write',
        expected: { grant: snapshot.grant },
        set: { grant: toGrant },
        event: { kind: 'visibility_changed', payload: { fromGrant: snapshot.grant, toGrant } },
      };
    };
  }

  describe('operationId', () => {
    test('persists a caller-supplied operationId on the materialized event', async () => {
      const created = await Page.createPage('/pec/operation-id-supplied', 'v1', user, {});
      const operationId = 'caller-operation-id';

      const outcome = await runPageEventCommand(crowi, {
        pageId: created._id,
        actor: user._id,
        source: 'web',
        plan: createGrantChangePlan(Page.GRANT_RESTRICTED),
        operationId,
      });

      expect(outcome.status).toBe('committed');
      const event = await PageHistoryEvent.findOne({ page: created._id }).lean();
      expect(event?.operationId).toBe(operationId);
    });

    test('generates an operationId when the caller omits it', async () => {
      const created = await Page.createPage('/pec/operation-id-generated', 'v1', user, {});

      const outcome = await runPageEventCommand(crowi, {
        pageId: created._id,
        actor: user._id,
        source: 'web',
        plan: createGrantChangePlan(Page.GRANT_RESTRICTED),
      });

      expect(outcome.status).toBe('committed');
      const event = await PageHistoryEvent.findOne({ page: created._id }).lean();
      expect(event?.operationId).toEqual(expect.any(String));
      expect(event?.operationId).not.toHaveLength(0);
    });

    test('preserves a caller-supplied operationId after a lost CAS race retries', async () => {
      const created = await Page.createPage('/pec/operation-id-retry', 'v1', user, {});
      const operationId = 'caller-operation-id-after-retry';
      const findOneAndUpdateSpy = jest
        .spyOn(Page, 'findOneAndUpdate')
        .mockImplementationOnce(() => ({ exec: () => Promise.resolve(null) }) as unknown as ReturnType<typeof Page.findOneAndUpdate>);

      let outcome: Awaited<ReturnType<typeof runPageEventCommand>>;
      let callCount: number;
      let attemptUpdates: Array<{
        $set: { pendingHistoryEntry: { event: { _id: Types.ObjectId; operationId: string } } };
      }>;
      try {
        outcome = await runPageEventCommand(crowi, {
          pageId: created._id,
          actor: user._id,
          source: 'web',
          plan: createGrantChangePlan(Page.GRANT_RESTRICTED),
          operationId,
        });
      } finally {
        callCount = findOneAndUpdateSpy.mock.calls.length;
        attemptUpdates = findOneAndUpdateSpy.mock.calls.map(([, update]) => update);
        findOneAndUpdateSpy.mockRestore();
      }

      expect(outcome.status).toBe('committed');
      expect(callCount).toBe(2);
      const firstAttemptEvent = attemptUpdates[0].$set.pendingHistoryEntry.event;
      const secondAttemptEvent = attemptUpdates[1].$set.pendingHistoryEntry.event;
      // One caller-pinned operation spans retries/pages, but each attempt gets a fresh eventId because a losing CAS persists nothing.
      expect(firstAttemptEvent.operationId).toBe(operationId);
      expect(secondAttemptEvent.operationId).toBe(firstAttemptEvent.operationId);
      expect(secondAttemptEvent._id).not.toEqual(firstAttemptEvent._id);
      const event = await PageHistoryEvent.findOne({ page: created._id }).lean();
      expect(event?.operationId).toBe(operationId);
    });
  });

  describe('AC-1/AC-2: ready Page grant change — event + no-event (same-grant) branches', () => {
    test('AC-1: confirms grant/grantedUsers and appends a visibility_changed event in one CAS', async () => {
      const created = await Page.createPage('/pec/ac1', 'v1', user, {});
      // `allocateContentSequence` (Phase 2a) promotes the Page via a SEPARATE
      // DB write after `pushRevision` commits — never a mutation of the
      // in-memory object `createPage` resolves with. Re-fetch to observe it.
      const beforeReload = await Page.findById(created._id).lean();
      expect(beforeReload?.historyTracking?.state).toBe('ready');
      expect(beforeReload?.historySequence).toBe(1);

      const outcome = await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id, source: 'web' });

      expect(outcome.status).toBe('committed');
      if (outcome.status !== 'committed') throw new Error('unreachable');
      expect(outcome.sequence).toBe(2);
      expect(outcome.eventId).not.toBeNull();
      expect(outcome.materialized).toBe(true);

      const page = await Page.findById(created._id).lean();
      expect(page?.grant).toBe(Page.GRANT_RESTRICTED);
      expect((page?.grantedUsers ?? []).map(String)).toEqual([String(user._id)]);
      expect(page?.historySequence).toBe(2);
      expect(page?.pendingHistoryEntry).toBeUndefined();

      const events = await PageHistoryEvent.find({ page: created._id }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('visibility_changed');
      expect(events[0].sequence).toBe(2);
      expect(events[0].source).toBe('web');
      expect(events[0].payload).toEqual({ fromGrant: Page.GRANT_PUBLIC, toGrant: Page.GRANT_RESTRICTED });
    });

    test('AC-2: a same-grant call rebuilds grantedUsers but creates no event and leaves historySequence untouched', async () => {
      const created = await Page.createPage('/pec/ac2', 'v1', user, {});
      // `created.grantedUsers[0]` is the in-memory-populated `user` Document
      // `createPage` was called with (not yet cast to a bare ObjectId) —
      // read back via `.lean()` to see the stored (plain ObjectId) value.
      const beforeReload = await Page.findById(created._id).lean();
      expect((beforeReload?.grantedUsers ?? []).map(String)).toEqual([String(user._id)]);

      const outcome = await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_PUBLIC, actor: user._id });

      expect(outcome.status).toBe('committed');
      if (outcome.status !== 'committed') throw new Error('unreachable');
      expect(outcome.sequence).toBeNull();
      expect(outcome.eventId).toBeNull();

      const page = await Page.findById(created._id).lean();
      expect(page?.grant).toBe(Page.GRANT_PUBLIC);
      // Rebuilt, not skipped — a public grant always resets grantedUsers to [].
      expect(page?.grantedUsers ?? []).toEqual([]);
      expect(page?.historySequence).toBe(1);
      expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
    });
  });

  test('AC-3: an untracked Page grant change succeeds today-identically — no event, historySequence/pendingHistoryEntry untouched', async () => {
    const page = await createUntrackedPage('/pec/ac3');
    expect(page.historyTracking.state).toBe('untracked');

    const outcome = await changePageVisibility(crowi, { pageId: page._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });

    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome.sequence).toBeNull();
    expect(outcome.eventId).toBeNull();

    const reloaded = await Page.findById(page._id).lean();
    expect(reloaded?.grant).toBe(Page.GRANT_RESTRICTED);
    expect(reloaded?.historyTracking?.state).toBe('untracked');
    expect(reloaded?.historySequence).toBe(0);
    expect(reloaded?.pendingHistoryEntry).toBeUndefined();
    expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
  });

  test('AC-4: a ready Page with `grant` unset at the driver level still commits — no schema-default pin, no event', async () => {
    const created = await Page.createPage('/pec/ac4', 'v1', user, {});
    await Page.collection.updateOne({ _id: created._id }, { $unset: { grant: '' } });
    const beforeLean = await Page.findById(created._id).lean();
    expect(beforeLean?.grant).toBeUndefined();

    const outcome = await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });

    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome.sequence).toBeNull();
    expect(outcome.eventId).toBeNull();

    const page = await Page.findById(created._id).lean();
    expect(page?.grant).toBe(Page.GRANT_RESTRICTED);
    expect(page?.historySequence).toBe(1); // no-event branch never touches it
    expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
  });

  test('AC-4: a ready Page with `grant` stored as `null` at the driver level still commits — same no-event branch as the missing-field case', async () => {
    const created = await Page.createPage('/pec/ac4-null', 'v1', user, {});
    await Page.collection.updateOne({ _id: created._id }, { $set: { grant: null } });
    const beforeLean = await Page.findById(created._id).lean();
    expect(beforeLean?.grant).toBeNull();

    const outcome = await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });

    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome.sequence).toBeNull();
    expect(outcome.eventId).toBeNull();

    const page = await Page.findById(created._id).lean();
    expect(page?.grant).toBe(Page.GRANT_RESTRICTED);
    expect(page?.historySequence).toBe(1); // no-event branch never touches it
    expect(page?.pendingHistoryEntry).toBeUndefined();
    expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
  });

  describe('AC-5: Page.updatePage body+grant integration (DC-11 sequence-is-allocation-order)', () => {
    test('AC-5a: content sequence and visibility sequence become consecutive when content allocation succeeds inline', async () => {
      const created = await Page.createPage('/pec/ac5a', 'v1', user, {});
      const updated = await Page.updatePage(created, 'v2', user, { grant: Page.GRANT_RESTRICTED });

      const reloadedPage = await Page.findById(created._id).lean();
      expect(reloadedPage?.historySequence).toBe(3); // 1 (create) -> 2 (content) -> 3 (visibility)

      const newRevision = await Revision.findById(updated.revision).lean();
      expect(newRevision?.historySequence).toBe(2);

      const events = await PageHistoryEvent.find({ page: created._id }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].sequence).toBe(3);
      expect(events[0].payload).toEqual({ fromGrant: Page.GRANT_PUBLIC, toGrant: Page.GRANT_RESTRICTED });
    });

    test('AC-5b: when content allocation fails inline, the visibility event is assigned first and repair later assigns the content Revision a LARGER sequence', async () => {
      const created = await Page.createPage('/pec/ac5b', 'v1', user, {});
      const spy = jest.spyOn(contentSequenceModule, 'allocateContentSequence').mockResolvedValueOnce({ allocated: false, reason: 'contended' });

      let updated: Awaited<ReturnType<typeof Page.updatePage>>;
      try {
        updated = await Page.updatePage(created, 'v2', user, { grant: Page.GRANT_RESTRICTED });
      } finally {
        spy.mockRestore();
      }

      const unsequencedRevision = await Revision.findById(updated.revision).lean();
      expect(unsequencedRevision?.historySequence).toBeUndefined();

      const events = await PageHistoryEvent.find({ page: created._id }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].sequence).toBe(2); // the ONLY successful allocation so far

      const pageAfterGrant = await Page.findById(created._id).select('historySequence').lean();
      expect(pageAfterGrant?.historySequence).toBe(2);

      // repair assigns the still-unsequenced content Revision the NEXT value
      // — LARGER than the already-committed visibility event's sequence,
      // even though the body write happened first (DC-11: allocation order,
      // not time order).
      const repairResult = await scanUnsequencedRevisions(crowi, { minAgeMs: 0 });
      expect(repairResult.blocked).toEqual([]);
      const reloadedRevision = await Revision.findById(updated.revision).lean();
      expect(reloadedRevision?.historySequence).toBe(3);
    });
  });

  test('AC-6: a jammed outbox blocks the grant change entirely after attempting to drain — grant/grantedUsers/historySequence/outbox all untouched', async () => {
    const created = await Page.createPage('/pec/ac6', 'v1', user, {});
    await stageJammedOutbox(created._id);
    const before = await Page.findById(created._id).lean();

    const outcome = await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });

    expect(outcome).toEqual({ status: 'contended', reason: 'drain-budget-exhausted' });

    const after = await Page.findById(created._id).lean();
    expect(after?.grant).toBe(before?.grant);
    expect((after?.grantedUsers ?? []).map(String)).toEqual((before?.grantedUsers ?? []).map(String));
    expect(after?.historySequence).toBe(before?.historySequence);
    expect(String(after?.pendingHistoryEntry?.entryId)).toBe(String(before?.pendingHistoryEntry?.entryId));
    expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
  });

  test('AC-7: a materialize failure after the CAS commits still reports success; the grant change is durable and repair completes materialization exactly once', async () => {
    const created = await Page.createPage('/pec/ac7', 'v1', user, {});
    const materializeSpy = jest.spyOn(materializeModule, 'materializePendingEntry').mockImplementationOnce(async () => {
      throw new Error('injected materialize failure');
    });

    let outcome: Awaited<ReturnType<typeof changePageVisibility>>;
    try {
      outcome = await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });
    } finally {
      materializeSpy.mockRestore();
    }

    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome.materialized).toBe(false);

    const pageAfterCas = await Page.findById(created._id).lean();
    expect(pageAfterCas?.grant).toBe(Page.GRANT_RESTRICTED); // durable despite the materialize failure
    expect(pageAfterCas?.pendingHistoryEntry).toBeDefined(); // still occupied
    expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);

    const repairResult = await repairPendingEntries(crowi);
    expect(repairResult.repairedPageIds).toContain(String(created._id));
    expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(1);

    // Re-running repair again is a no-op — never duplicates.
    const secondRepair = await repairPendingEntries(crowi);
    expect(secondRepair.repairedPageIds).not.toContain(String(created._id));
    expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(1);
  });

  test('AC-14: the persisted visibility_changed payload has ONLY fromGrant/toGrant — no grantedUsers/user id/path/body', async () => {
    const created = await Page.createPage('/pec/ac14', 'v1', user, {});
    await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });

    const event = await PageHistoryEvent.findOne({ page: created._id }).lean();
    expect(event).not.toBeNull();
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(['fromGrant', 'toGrant']);
  });

  test("AC-15: this spec's writers never create a PageHistoryOperation row", async () => {
    const created = await Page.createPage('/pec/ac15', 'v1', user, {});
    await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id });
    await changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_PUBLIC, actor: user._id });

    expect(await PageHistoryOperation.countDocuments({})).toBe(0);
  });

  describe('AC-16: grant-preserving ACL writes never create an event', () => {
    test('Page.pushToGrantedUsers (membership-only) creates no event', async () => {
      const created = await Page.createPage('/pec/ac16-push', 'v1', user, {});
      await Page.pushToGrantedUsers(created, otherUser._id);

      expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
    });

    test('the link-access claim ($addToSet on grantedUsers) creates no event', async () => {
      const created = await Page.createPage('/pec/ac16-link-access', 'v1', user, { grant: Page.GRANT_RESTRICTED });

      const { granted } = await Page.findPageByIdForSharedLinkAccess(created._id, otherUser);
      expect(granted).toBe(true);

      expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
    });
  });

  test('AC-19: a content save racing a grant change on the same ready Page never produces a duplicate sequence', async () => {
    const created = await Page.createPage('/pec/ac19', 'v1', user, {});
    const nextRevision = await Revision.create({ page: created._id, path: created.path, body: 'v2', format: 'markdown', author: user._id });
    await Page.updateOne({ _id: created._id }, { $set: { revision: nextRevision._id } });

    const [contentOutcome, visibilityOutcome] = await Promise.all([
      contentSequenceModule.allocateContentSequence(crowi, created._id, nextRevision._id),
      changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id }),
    ]);

    expect(contentOutcome.allocated).toBe(true);
    expect(visibilityOutcome.status).toBe('committed');
    if (!contentOutcome.allocated || visibilityOutcome.status !== 'committed') throw new Error('unreachable');

    expect(contentOutcome.sequence).not.toBe(visibilityOutcome.sequence);

    const finalPage = await Page.findById(created._id).select('historySequence').lean();
    expect(finalPage?.historySequence).toBe(3); // 1 (create) + one allocation each from the two racers

    const reloadedRevision = await Revision.findById(nextRevision._id).lean();
    expect(reloadedRevision?.historySequence).toBe(contentOutcome.sequence);

    const events = await PageHistoryEvent.find({ page: created._id }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(visibilityOutcome.sequence);
  });

  test("AC-20: two concurrent grant changes never lose an event; the later row's fromGrant equals the earlier row's toGrant", async () => {
    const created = await Page.createPage('/pec/ac20', 'v1', user, {});

    const [outcomeA, outcomeB] = await Promise.all([
      changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_RESTRICTED, actor: user._id }),
      changePageVisibility(crowi, { pageId: created._id, toGrant: Page.GRANT_SPECIFIED, actor: user._id }),
    ]);

    expect(outcomeA.status).toBe('committed');
    expect(outcomeB.status).toBe('committed');

    const events = await PageHistoryEvent.find({ page: created._id }).sort({ sequence: 1 }).lean();
    expect(events).toHaveLength(2);
    expect(events[1].payload.fromGrant).toBe(events[0].payload.toGrant);
    expect(events.map((e) => e.payload.toGrant).sort()).toEqual([Page.GRANT_RESTRICTED, Page.GRANT_SPECIFIED].sort());
  });

  describe('publishDraftPage (RFC-0021 §6.3, Phase C)', () => {
    test('AC-8: a ready draft publishes — status flips to published and a draft_published event is appended', async () => {
      const draft = await createReadyDraftPage('/pec/ac8');
      const beforeReload = await Page.findById(draft._id).lean();
      expect(beforeReload?.historyTracking?.state).toBe('ready');
      expect(beforeReload?.status).toBe(STATUS_DRAFT);
      const beforeSequence = beforeReload?.historySequence;

      const outcome = await publishDraftPage(crowi, { pageId: draft._id, actor: user._id });

      expect(outcome.status).toBe('committed');
      if (outcome.status !== 'committed') throw new Error('unreachable');
      expect(outcome.eventId).not.toBeNull();
      expect(outcome.sequence).toBe((beforeSequence ?? 0) + 1);
      expect(outcome.materialized).toBe(true);

      const page = await Page.findById(draft._id).lean();
      expect(page?.status).toBe(STATUS_PUBLISHED);
      expect(page?.historySequence).toBe((beforeSequence ?? 0) + 1);

      const events = await PageHistoryEvent.find({ page: draft._id }).lean();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('draft_published');
      expect(events[0].sequence).toBe((beforeSequence ?? 0) + 1);
      expect(events[0].source).toBe('collab');
      expect(events[0].payload).toEqual({ fromStatus: 'draft', toStatus: 'published' });
      // AC-14 applies to every kind this spec writes, not just visibility_changed — pin it here too.
      expect(Object.keys(events[0].payload ?? {}).sort()).toEqual(['fromStatus', 'toStatus']);
    });

    test('AC-9: an already-published Page never triggers a write and creates no event', async () => {
      const created = await Page.createPage('/pec/ac9', 'v1', user, {});
      const before = await Page.findById(created._id).lean();
      // "no write issued" is stronger than "end state unchanged" (an identity
      // $set on an already-published Page would also leave the end state
      // unchanged) — spy on the skeleton's only write primitive to pin it.
      const findOneAndUpdateSpy = jest.spyOn(Page, 'findOneAndUpdate');

      let outcome: Awaited<ReturnType<typeof publishDraftPage>>;
      // `mockRestore()` clears `.mock.calls` (it's `mockReset()` + restoring
      // the original impl) — capture the count BEFORE restoring, not after.
      let callCount: number;
      try {
        outcome = await publishDraftPage(crowi, { pageId: created._id, actor: user._id });
      } finally {
        callCount = findOneAndUpdateSpy.mock.calls.length;
        findOneAndUpdateSpy.mockRestore();
      }

      expect(outcome).toEqual({ status: 'noop', reason: 'not-draft' });
      expect(callCount).toBe(0);

      const after = await Page.findById(created._id).lean();
      expect(after?.status).toBe(before?.status);
      expect(after?.historySequence).toBe(before?.historySequence);
      expect(await PageHistoryEvent.countDocuments({ page: created._id })).toBe(0);
    });

    test('AC-10: a jammed outbox blocks the publish — status stays draft, no event, contended outcome', async () => {
      const draft = await createReadyDraftPage('/pec/ac10');
      await stageJammedOutbox(draft._id);

      const outcome = await publishDraftPage(crowi, { pageId: draft._id, actor: user._id });

      expect(outcome).toEqual({ status: 'contended', reason: 'drain-budget-exhausted' });

      const page = await Page.findById(draft._id).lean();
      expect(page?.status).toBe(STATUS_DRAFT);
      expect(await PageHistoryEvent.countDocuments({ page: draft._id })).toBe(0);
    });

    test('AC-10: the publish CAS itself losing every retry (not a jammed outbox) exhausts the claim budget — status stays draft, no event', async () => {
      const draft = await createReadyDraftPage('/pec/ac10-cas-miss');
      // The outbox is empty here (unlike the jammed-outbox case above), so
      // this exercises the OTHER `contended` reason: `Page.findOneAndUpdate`
      // itself never lands (a concurrent writer keeps winning the optimistic
      // lock), exhausting the claim budget rather than the drain-assist one.
      const findOneAndUpdateSpy = jest
        .spyOn(Page, 'findOneAndUpdate')
        .mockReturnValue({ exec: () => Promise.resolve(null) } as unknown as ReturnType<typeof Page.findOneAndUpdate>);

      let outcome: Awaited<ReturnType<typeof publishDraftPage>>;
      // `mockRestore()` clears `.mock.calls` (it's `mockReset()` + restoring
      // the original impl) — capture the count BEFORE restoring, not after.
      let callCount: number;
      try {
        outcome = await publishDraftPage(crowi, { pageId: draft._id, actor: user._id });
      } finally {
        callCount = findOneAndUpdateSpy.mock.calls.length;
        findOneAndUpdateSpy.mockRestore();
      }

      expect(outcome).toEqual({ status: 'contended', reason: 'claim-budget-exhausted' });
      expect(callCount).toBe(3); // DEFAULT_MAX_CLAIM_ATTEMPTS (DC-9: same budget as Phase 2a)

      const page = await Page.findById(draft._id).lean();
      expect(page?.status).toBe(STATUS_DRAFT);
      expect(await PageHistoryEvent.countDocuments({ page: draft._id })).toBe(0);
    });

    test('AC-25: an untracked draft still publishes today-identically — status flips, no event, historySequence/pendingHistoryEntry untouched', async () => {
      const draft = await createUntrackedDraftPage('/pec/ac25');
      expect(draft.historyTracking.state).toBe('untracked');

      const outcome = await publishDraftPage(crowi, { pageId: draft._id, actor: user._id });

      expect(outcome.status).toBe('committed');
      if (outcome.status !== 'committed') throw new Error('unreachable');
      expect(outcome.sequence).toBeNull();
      expect(outcome.eventId).toBeNull();

      const page = await Page.findById(draft._id).lean();
      expect(page?.status).toBe(STATUS_PUBLISHED);
      expect(page?.historyTracking?.state).toBe('untracked');
      expect(page?.historySequence).toBe(0);
      expect(page?.pendingHistoryEntry).toBeUndefined();
      expect(await PageHistoryEvent.countDocuments({ page: draft._id })).toBe(0);
    });
  });
});
