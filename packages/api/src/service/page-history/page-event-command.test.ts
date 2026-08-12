import { Types } from 'mongoose';
import { STATUS_PUBLISHED } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { changePageVisibility } from './commands/visibility';
import * as contentSequenceModule from './content-sequence';
import * as materializeModule from './materialize';
import { repairPendingEntries, scanUnsequencedRevisions } from './repair';

/**
 * RFC-0021 §6.2 (Phase 2c-1) — `runPageEventCommand`/`changePageVisibility`
 * coverage: the shared CAS-and-event skeleton (AC-1/2/3/4/6/7/14/15/16/19/20)
 * plus `Page.updatePage`'s body+grant integration (AC-5). Draft publish
 * (AC-8/9/10/17/18/25) is Phase C, out of scope here.
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
  async function createUntrackedPage(path: string, grant = Page.GRANT_PUBLIC) {
    return Page.create({
      path,
      creator: user._id,
      lastUpdateUser: user._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      redirectTo: null,
      grant,
      status: STATUS_PUBLISHED,
      grantedUsers: [user._id],
    });
  }

  /** A malformed `page_event` outbox entry (no `event`) — `materializePendingEntry` throws on it every time (`assertWellFormedPendingEntry`), so drain-assist can never clear it. Reliably exhausts the drain-assist budget without needing to mock anything. */
  async function stageJammedOutbox(pageId: Types.ObjectId) {
    await Page.updateOne({ _id: pageId }, { $set: { pendingHistoryEntry: { entryId: new Types.ObjectId(), type: 'page_event' } } });
  }

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
});
