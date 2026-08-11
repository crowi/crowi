import { Types } from 'mongoose';
import type { PendingHistoryEntry } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { drainPendingHistoryEntry, materializePendingEntry } from './materialize';
import { repairPendingEntries, scanUnsequencedRevisions } from './repair';

/**
 * feature-page-history-phase1-model (RFC-0021 §6.4/§13.2a/§16.1, Phase 1) —
 * the materializer's idempotency (AC-5), failure-injection recovery (AC-6),
 * the unsequenced-Revision repair scan (AC-7), and duplicate-sequence
 * blocking (AC-8).
 *
 * RFC §16.1's phase-1 requirement is "add failure-injection tests before
 * enabling writers" — Phase 1 ships no writer, so every scenario here is
 * built directly against `Page.pendingHistoryEntry` / `Revision` /
 * `PageHistoryEvent`, the same shapes Phase 2's command services will
 * write.
 */

describe('service/page-history (RFC-0021 Phase 1, feature-page-history-phase1-model)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let user;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    await PageHistoryEvent.syncIndexes();

    const [testUser] = await Fixture.generate('User', [{ name: 'Repair Tester', username: 'repair-tester', email: 'repair-tester@example.com' }]);
    user = testUser;
  });

  /**
   * `scanUnsequencedRevisions` only visits Pages whose `historyTracking.state`
   * is `ready`, and Phase 1 ships nothing that reaches that state: creation
   * leaves a Page `untracked` precisely because Phase 1 allocates no sequence
   * for its initial Revision (see the create hook's comment in
   * `models/page.ts`). Phase 2's create command and backfill are what promote
   * a Page. So the scan's own tests have to arrange the state they scan for.
   */
  const createReadyPage = async (path, body = 'v0') => {
    const page = await Page.createPage(path, body, user, {});
    await Page.updateOne({ _id: page._id }, { $set: { historyTracking: { state: 'ready', trackingStartedAt: new Date() } } });
    return page;
  };

  // `entryId` (RFC §5.5, revised — AC-5b) defaults to a fresh ObjectId when
  // the caller's fixture doesn't set one, so the many pre-existing fixtures
  // below that don't care about entryId's VALUE (only tests that exercise
  // drain-identity semantics construct it explicitly) don't all need
  // individual edits.
  async function claimOutbox(pageId, entry) {
    const withEntryId = { entryId: new Types.ObjectId(), ...entry };
    const result = await Page.updateOne({ _id: pageId, pendingHistoryEntry: null }, { $set: { pendingHistoryEntry: withEntryId } });
    expect(result.modifiedCount).toBe(1);
    return withEntryId;
  }

  describe('materializePendingEntry — idempotency (AC-5)', () => {
    test('page_event: repeated calls create exactly one PageHistoryEvent and converge on the same state', async () => {
      const page = await Page.createPage('/repair/materialize-page-event', 'v1', user, {});
      const eventId = new Types.ObjectId();
      const entry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-materialize-1',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await claimOutbox(page._id, entry);

      const first = await materializePendingEntry(crowi, page._id);
      expect(first.drained).toBe(true);
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);

      // Re-running against an already-drained outbox is a no-op.
      const second = await materializePendingEntry(crowi, page._id);
      expect(second.drained).toBe(false);
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);

      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.pendingHistoryEntry).toBeUndefined();
    });

    test('content_revision: repeated calls set historySequence/historyOperationId exactly once', async () => {
      const page = await Page.createPage('/repair/materialize-content-revision', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const entry = { type: 'content_revision', revisionId: revision._id, sequence: 7, occurredAt: new Date(), operationId: 'op-materialize-2' };
      await claimOutbox(page._id, entry);

      await materializePendingEntry(crowi, page._id);
      const afterFirst = await Revision.findById(revision._id).lean();
      expect(afterFirst.historySequence).toBe(7);
      expect(afterFirst.historyOperationId).toBe('op-materialize-2');

      // Re-run: the outbox is already drained, so this is a pure no-op —
      // NOT a second attempt to write the same target (the guard exists
      // for the crash-before-drain case exercised below).
      const again = await materializePendingEntry(crowi, page._id);
      expect(again.drained).toBe(false);
      const afterSecond = await Revision.findById(revision._id).lean();
      expect(afterSecond.historySequence).toBe(7);
    });

    test('migration_revision: repeated calls set historySequence only, without touching the Page revision pointer', async () => {
      const page = await Page.createPage('/repair/materialize-migration-revision', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const entry = { type: 'migration_revision', revisionId: revision._id, sequence: 3, migrationOwner: 'test-migration' };
      await claimOutbox(page._id, entry);
      // `page.revision` here is a live Revision DOCUMENT (createPage's own
      // `pushRevision` assigns the instance, not a bare id — see DC-5's doc
      // comments in models/page.ts), so its own `_id` is what identifies it,
      // not `String(page.revision)` (Mongoose's debug inspect override).
      const revisionPointerBefore = String(page.revision._id);

      await materializePendingEntry(crowi, page._id);
      const reloadedRevision = await Revision.findById(revision._id).lean();
      expect(reloadedRevision.historySequence).toBe(3);
      expect(reloadedRevision.historyOperationId).toBeUndefined();

      const reloadedPage = await Page.findById(page._id);
      expect(String(reloadedPage.revision)).toBe(revisionPointerBefore);
    });

    test('materializing an empty outbox is a no-op', async () => {
      const page = await Page.createPage('/repair/materialize-empty-outbox', 'v1', user, {});
      const result = await materializePendingEntry(crowi, page._id);
      expect(result.drained).toBe(false);
    });
  });

  describe('failure injection — crash after target materialization but before drain (AC-6)', () => {
    /**
     * `drainPendingHistoryEntry` (the LAST step of `materializePendingEntry`)
     * always issues a `Page.updateOne(..., { $unset: { pendingHistoryEntry: '' } })`.
     * Intercepting exactly that call — and letting every other `Page.updateOne`
     * through unmodified — simulates a crash between "target durably written"
     * and "outbox marker cleared", independent of which of the 3 outbox
     * variants is in flight.
     */
    function injectCrashBeforeDrain() {
      const original = Page.updateOne.bind(Page);
      return jest.spyOn(Page, 'updateOne').mockImplementation((filter, update, ...rest) => {
        if (update?.$unset?.pendingHistoryEntry !== undefined) {
          throw new Error('injected crash before drain');
        }
        return original(filter, update, ...rest);
      });
    }

    test('page_event: crash before drain leaves the outbox occupied but the event already durable; repair converges with no duplicate', async () => {
      const page = await Page.createPage('/repair/crash-page-event', 'v1', user, {});
      const eventId = new Types.ObjectId();
      const entry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-crash-1',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await claimOutbox(page._id, entry);

      const spy = injectCrashBeforeDrain();
      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow('injected crash before drain');
      spy.mockRestore();

      // The event is durable, but the outbox marker is still occupied —
      // the exact "crashed between materialize and drain" state.
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);
      const stillPending = await Page.findById(page._id);
      expect(stillPending.pendingHistoryEntry).toBeDefined();

      const repairResult = await repairPendingEntries(crowi);
      expect(repairResult.repairedPageIds).toContain(String(page._id));
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
    });

    /**
     * AC-5/AC-5b (codex review attempt 2, round 6): the test above proves
     * recovery converges when the staged `entry.event` is untouched between
     * the crash and the repair pass. This one proves the harder claim the
     * review flagged as missing — recovery must ALSO converge when, in the
     * window between "event already durably written" and "outbox drained",
     * the STAGED (now-redundant) outbox copy of that same event gets
     * corrupted by a native-driver bypass. `materializePendingEntry` used to
     * validate/hydrate `entry.event` unconditionally on every call — so a
     * corrupted, schema-unknown payload field on the SECOND (recovery) call
     * threw `StrictModeError` even though the ONLY remaining step was
     * draining an already-durable event, permanently blocking recovery.
     */
    test('page_event: crash before drain, then the STAGED outbox copy gets a schema-unknown payload field — recovery still converges (it never re-validates an already-materialized event)', async () => {
      const page = await Page.createPage('/repair/crash-page-event-then-corrupted', 'v1', user, {});
      const eventId = new Types.ObjectId();
      const entry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-crash-then-corrupted',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await claimOutbox(page._id, entry);

      const spy = injectCrashBeforeDrain();
      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow('injected crash before drain');
      spy.mockRestore();

      // The event is already durable; the outbox marker is still occupied.
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);

      // Native driver bypass — corrupt the STAGED (redundant) outbox copy's
      // payload with a field this schema declares nowhere. A live writer
      // could never produce this (the schema's `strict: 'throw'` would
      // reject it), but a corrupted/partially-written document reaching
      // this state on retry is exactly the scenario recovery must survive.
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.event.payload.injectedUnknownField': 'x' } });

      // Recovery must NOT throw — the event is already durable, so this
      // call should skip validation entirely and just drain.
      const result = await materializePendingEntry(crowi, page._id);
      expect(result.drained).toBe(true);

      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
    });

    test('content_revision: crash before drain leaves historySequence set but the outbox occupied; repair drains without re-writing', async () => {
      const page = await Page.createPage('/repair/crash-content-revision', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const entry = { type: 'content_revision', revisionId: revision._id, sequence: 4, occurredAt: new Date(), operationId: 'op-crash-2' };
      await claimOutbox(page._id, entry);

      const spy = injectCrashBeforeDrain();
      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow('injected crash before drain');
      spy.mockRestore();

      const midway = await Revision.findById(revision._id).lean();
      expect(midway.historySequence).toBe(4);
      const stillPending = await Page.findById(page._id);
      expect(stillPending.pendingHistoryEntry).toBeDefined();

      const repairResult = await repairPendingEntries(crowi);
      expect(repairResult.repairedPageIds).toContain(String(page._id));
      const final = await Revision.findById(revision._id).lean();
      expect(final.historySequence).toBe(4);
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
    });

    test('migration_revision: crash before drain leaves historySequence set but the outbox occupied; repair drains without touching the Page revision pointer', async () => {
      const page = await Page.createPage('/repair/crash-migration-revision', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const entry = { type: 'migration_revision', revisionId: revision._id, sequence: 6, migrationOwner: 'test-migration-crash' };
      await claimOutbox(page._id, entry);
      const revisionPointerBefore = String(page.revision._id);

      const spy = injectCrashBeforeDrain();
      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow('injected crash before drain');
      spy.mockRestore();

      const midway = await Revision.findById(revision._id).lean();
      expect(midway.historySequence).toBe(6);
      const stillPending = await Page.findById(page._id);
      expect(stillPending.pendingHistoryEntry).toBeDefined();

      const repairResult = await repairPendingEntries(crowi);
      expect(repairResult.repairedPageIds).toContain(String(page._id));
      const final = await Revision.findById(revision._id).lean();
      expect(final.historySequence).toBe(6);
      expect(final.historyOperationId).toBeUndefined();
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
      expect(String(reloaded.revision)).toBe(revisionPointerBefore);
    });
  });

  describe('failure injection — pre-materialize interruption + multi-variant recovery in one repair pass (AC-6)', () => {
    /**
     * "Crashed before EVER calling `materializePendingEntry`" — the outbox
     * slot was claimed (the Page CAS that writes `pendingHistoryEntry`
     * committed) but the crash happened before any materialize attempt, so
     * neither the target write NOR the drain has happened yet. This is a
     * DIFFERENT boundary than "crash after target materialization but
     * before drain" above: here `repairPendingEntries` must do the FULL
     * job (target write + drain) from a completely cold start, for all 3
     * outbox variants, in a SINGLE repair pass across multiple Pages —
     * exercising both the missing boundary and the missing multi-variant
     * coverage the codex review (attempt 2) flagged.
     */
    test('three Pages, one pending entry each (page_event / content_revision / migration_revision), none ever materialized: one repairPendingEntries() pass completes all three', async () => {
      const pageA = await Page.createPage('/repair/multi-variant-page-event', 'v1', user, {});
      const pageB = await Page.createPage('/repair/multi-variant-content-revision', 'v1', user, {});
      const pageC = await Page.createPage('/repair/multi-variant-migration-revision', 'v1', user, {});

      const eventId = new Types.ObjectId();
      const pageEventEntry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: pageA._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-multi-a',
          source: 'web',
          payload: { path: pageA.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      const revisionB = await Revision.create({ page: pageB._id, path: pageB.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const contentRevisionEntry = { type: 'content_revision', revisionId: revisionB._id, sequence: 9, occurredAt: new Date(), operationId: 'op-multi-b' };
      const revisionC = await Revision.create({ page: pageC._id, path: pageC.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const migrationRevisionEntry = { type: 'migration_revision', revisionId: revisionC._id, sequence: 11, migrationOwner: 'test-multi-variant' };

      await claimOutbox(pageA._id, pageEventEntry);
      await claimOutbox(pageB._id, contentRevisionEntry);
      await claimOutbox(pageC._id, migrationRevisionEntry);

      // Cold start: `materializePendingEntry` has never run for any of the
      // three — this pass is the first thing to touch them.
      const result = await repairPendingEntries(crowi);

      expect(result.repairedPageIds).toEqual(expect.arrayContaining([String(pageA._id), String(pageB._id), String(pageC._id)]));
      expect(result.failed).toEqual([]);

      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);
      const finalB = await Revision.findById(revisionB._id).lean();
      expect(finalB.historySequence).toBe(9);
      expect(finalB.historyOperationId).toBe('op-multi-b');
      const finalC = await Revision.findById(revisionC._id).lean();
      expect(finalC.historySequence).toBe(11);
      expect(finalC.historyOperationId).toBeUndefined();

      for (const page of [pageA, pageB, pageC]) {
        const reloaded = await Page.findById(page._id);
        expect(reloaded.pendingHistoryEntry).toBeUndefined();
      }
    });
  });

  describe('materializePendingEntry — verify-before-drain catches corruption instead of draining over it', () => {
    test('a malformed entry (missing a required field for its type) is rejected before any write, and the outbox stays occupied', async () => {
      const page = await Page.createPage('/repair/malformed-entry', 'v1', user, {});
      // `content_revision` requires revisionId/sequence/operationId — this
      // one is missing `operationId`.
      const malformed = { type: 'content_revision', revisionId: new Types.ObjectId(), sequence: 1, occurredAt: new Date() };
      await claimOutbox(page._id, malformed);

      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow(/missing revisionId\/sequence\/operationId/);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });

    test('a content_revision entry missing `occurredAt` is rejected before any write, and the outbox stays occupied (codex review attempt 3)', async () => {
      const page = await Page.createPage('/repair/malformed-entry-no-occurredat', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      // revisionId/sequence/operationId are all present — only `occurredAt` is missing.
      const malformed = { type: 'content_revision', revisionId: revision._id, sequence: 1, operationId: 'op-no-occurredat' };
      await claimOutbox(page._id, malformed);

      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow(/missing revisionId\/sequence\/operationId\/occurredAt/);

      const untouched = await Revision.findById(revision._id).lean();
      expect(untouched.historySequence).toBeUndefined();
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });

    test('content_revision target Revision no longer exists: rejected, not silently drained', async () => {
      const page = await Page.createPage('/repair/revision-gone', 'v1', user, {});
      const entry = { type: 'content_revision', revisionId: new Types.ObjectId(), sequence: 1, occurredAt: new Date(), operationId: 'op-gone' };
      await claimOutbox(page._id, entry);

      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow(/revision .* not found/);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });

    test('page_event target _id already holds a DIFFERENT event: the upsert is a no-op (never overwrites) and the outbox still drains — no envelope comparison (spec revision: entryId is the only drain identity)', async () => {
      const page = await Page.createPage('/repair/page-event-collision', 'v1', user, {});
      const eventId = new Types.ObjectId();
      // A PageHistoryEvent already occupies this _id, with a totally
      // different page/sequence/kind/payload than the pending entry below.
      // Earlier revisions of this feature verified the FULL envelope
      // matched before draining and threw on any mismatch; the spec
      // revision replaced that with "page_event は ... 既に存在すれば何もしない"
      // (upsert-by-`_id`, no content comparison at all) — `entryId` alone
      // now decides whether the outbox drains.
      await PageHistoryEvent.create({
        _id: eventId,
        page: new Types.ObjectId(),
        sequence: 42,
        kind: 'page_created',
        actor: user._id,
        occurredAt: new Date(),
        operationId: 'op-preexisting',
        source: 'web',
        payload: { path: '/other', grant: Page.GRANT_PUBLIC, status: 'published' },
      });

      const entry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-collision',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await claimOutbox(page._id, entry);

      const result = await materializePendingEntry(crowi, page._id);
      expect(result.drained).toBe(true);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
      // The pre-existing (unrelated) event is untouched — `$setOnInsert`
      // never overwrites an existing document.
      const untouched = await PageHistoryEvent.findById(eventId).lean();
      expect(untouched.sequence).toBe(42);
      expect(untouched.operationId).toBe('op-preexisting');
    });

    test('page_event entry whose event.page does not match the outbox-owning Page is rejected BEFORE any write (codex review attempt 3)', async () => {
      const owningPage = await Page.createPage('/repair/page-event-wrong-owner', 'v1', user, {});
      const foreignPageId = new Types.ObjectId();
      const eventId = new Types.ObjectId();
      const entry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: foreignPageId, // claims a DIFFERENT page than the outbox slot it's stored on
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-wrong-owner',
          source: 'web',
          payload: { path: '/repair/page-event-wrong-owner', grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await claimOutbox(owningPage._id, entry);

      await expect(materializePendingEntry(crowi, owningPage._id)).rejects.toThrow(/claims page .* but is stored in Page/);

      // Rejected BEFORE the upsert — nothing was ever written for this _id.
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(0);
      const reloaded = await Page.findById(owningPage._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });

    test('content_revision entry pointing at a Revision owned by a DIFFERENT Page is rejected BEFORE any write (codex review attempt 3)', async () => {
      const pageA = await Page.createPage('/repair/content-revision-wrong-owner-a', 'v1', user, {});
      const pageB = await Page.createPage('/repair/content-revision-wrong-owner-b', 'v1', user, {});
      const revisionOnB = await Revision.create({
        page: pageB._id,
        path: pageB.path,
        body: 'owned-by-b',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
      });
      // Claimed on pageA's outbox slot, but the revisionId actually belongs to pageB.
      const entry = { type: 'content_revision', revisionId: revisionOnB._id, sequence: 1, occurredAt: new Date(), operationId: 'op-wrong-owner-revision' };
      await claimOutbox(pageA._id, entry);

      await expect(materializePendingEntry(crowi, pageA._id)).rejects.toThrow(/belongs to a different page/);

      const untouched = await Revision.findById(revisionOnB._id).lean();
      expect(untouched.historySequence).toBeUndefined();
      const reloaded = await Page.findById(pageA._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });

    test('content_revision entry pointing at an ORPHAN Revision (no `page` at all) is rejected — legacy-orphan allowance does not extend to this outbox path (codex review attempt 3)', async () => {
      const page = await Page.createPage('/repair/content-revision-orphan-revision', 'v1', user, {});
      // `Revision.page` is optional at the schema level (legacy orphans,
      // `models/revision.ts`'s doc comment) — deliberately omitted here.
      const orphanRevision = await Revision.create({
        path: '/repair/content-revision-orphan-revision',
        body: 'orphan',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
      });
      const entry = { type: 'content_revision', revisionId: orphanRevision._id, sequence: 1, occurredAt: new Date(), operationId: 'op-orphan-content' };
      await claimOutbox(page._id, entry);

      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow(/belongs to a different page/);

      const untouched = await Revision.findById(orphanRevision._id).lean();
      expect(untouched.historySequence).toBeUndefined();
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });

    test('migration_revision entry pointing at an ORPHAN Revision (no `page` at all) is rejected — same as content_revision (codex review attempt 3)', async () => {
      const page = await Page.createPage('/repair/migration-revision-orphan-revision', 'v1', user, {});
      const orphanRevision = await Revision.create({
        path: '/repair/migration-revision-orphan-revision',
        body: 'orphan',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
      });
      const entry = { type: 'migration_revision', revisionId: orphanRevision._id, sequence: 1, migrationOwner: 'test-orphan-migration' };
      await claimOutbox(page._id, entry);

      await expect(materializePendingEntry(crowi, page._id)).rejects.toThrow(/belongs to a different page/);

      const untouched = await Revision.findById(orphanRevision._id).lean();
      expect(untouched.historySequence).toBeUndefined();
      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeDefined();
    });
  });

  describe('operator report redaction — no raw field value ever reaches `failed[].reason` (AC-8b)', () => {
    test('a corrupt payload value that fails Mongoose validation is reported by FIELD NAME only — the raw (secret-shaped) value never appears in the report', async () => {
      const page = await Page.createPage('/repair/redaction-payload-enum', 'v1', user, {});
      const eventId = new Types.ObjectId();
      const secretValue = 'someone-secret@example.com';
      const entry = {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-redaction',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await claimOutbox(page._id, entry);

      // Native driver bypass — `Page.updateOne`/schema `strict: 'throw'`
      // would reject an out-of-enum `status` outright at write time; a
      // corrupt/malformed entry reaching this state (e.g. written by a
      // future buggy writer, or injected) is exactly the scenario this
      // redaction guards against. `status` (String, `enum: ['published',
      // 'draft']`) fails Mongoose's ENUM validator (deferred to
      // `candidate.validate()` in materialize.ts) — not a CastError — so
      // the raw string survives hydration unchanged and reaches the
      // validator with the literal secret-shaped value.
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.event.payload.status': secretValue } });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain(secretValue);
      expect(failure?.reason).toContain('payload.status');
      expect(failure?.reason).toContain('[redacted]');

      // The outbox slot is still occupied (materialize threw before drain)
      // — clean it up so it doesn't linger for later tests sharing this
      // database.
      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('an entry whose `type` discriminator is corrupted to a secret-shaped, unrecognized value is reported by FIELD NAME only (codex review attempt 5/2)', async () => {
      const page = await Page.createPage('/repair/redaction-unknown-type', 'v1', user, {});
      const secretValue = 'someone-secret@example.com';
      await claimOutbox(page._id, {
        type: 'content_revision',
        revisionId: new Types.ObjectId(),
        sequence: 1,
        occurredAt: new Date(),
        operationId: 'op-placeholder',
      });

      // Native driver bypass — corrupt the entry's own `type` discriminator
      // (a declared schema field, so it survives hydration unchanged) to a
      // secret-shaped value this module's `PendingHistoryEntry` union does
      // not recognize. `assertWellFormedPendingEntry`'s `default` branch (the
      // only code path that ever runs against an entry shaped like this)
      // used to `JSON.stringify` the WHOLE entry — including this corrupted
      // `type` value — into the thrown message; a disposable MongoDB repro
      // confirmed that string then survived unchanged through
      // `redactErrorReason`'s generic `Error` fallback into `failed[].reason`.
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.type': secretValue } });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain(secretValue);
      expect(failure?.reason).toContain('unrecognized pendingHistoryEntry type');
      expect(failure?.reason).toContain('entryId');
      expect(failure?.reason).toContain('type');

      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a content_revision historyOperationId mismatch (verify-after-write) is reported without either the expected or durably-stored operationId value (codex review attempt 5/2)', async () => {
      const page = await Page.createPage('/repair/redaction-operationid-mismatch', 'v1', user, {});
      const alreadyCommittedOperationId = 'already-committed-op';
      const revision = await Revision.create({
        page: page._id,
        path: page.path,
        body: 'v2',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
        historySequence: 9,
        historyOperationId: alreadyCommittedOperationId,
      });
      const secretValue = 'someone-secret@example.com';
      // Same target `sequence` as what's already committed (so the
      // `historySequence` check inside `verifyRevisionMaterialized` passes),
      // but a DIFFERENT `operationId` — an attacker/corrupt-writer-supplied
      // string, since this field has no enum/charset guard at the outbox
      // layer (RFC-0021's `Idempotency-Key` charset constraint lives on
      // `PageHistoryOperation`, a different model, not here).
      await claimOutbox(page._id, { type: 'content_revision', revisionId: revision._id, sequence: 9, occurredAt: new Date(), operationId: secretValue });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain(secretValue);
      expect(failure?.reason).not.toContain(alreadyCommittedOperationId);
      expect(failure?.reason).toContain('historyOperationId mismatch');

      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a content_revision historySequence mismatch (verify-after-write) is reported without the durably-stored value, even when that value was native-driver-corrupted to a secret-shaped string (codex review attempt 5/2, advisor follow-up)', async () => {
      const page = await Page.createPage('/repair/redaction-historysequence-mismatch', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      const secretValue = 'someone-secret@example.com';
      // Native driver bypass — `verifyRevisionMaterialized` reads the target
      // Revision with `.lean()`, which applies NO schema casting; a Number-
      // typed `historySequence` corrupted this way survives that read
      // completely unchanged (unlike a live Mongoose Document hydration,
      // which WOULD reject a non-numeric value with a CastError).
      await Revision.collection.updateOne({ _id: revision._id }, { $set: { historySequence: secretValue } });
      await claimOutbox(page._id, {
        type: 'content_revision',
        revisionId: revision._id,
        sequence: 1,
        occurredAt: new Date(),
        operationId: 'op-redaction-sequence',
      });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain(secretValue);
      expect(failure?.reason).toContain('historySequence mismatch');

      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a native-driver-injected, secret-shaped `sequence` on the outbox entry itself is never surfaced in the structured `failed[].sequence` field (codex review attempt 5/2, advisor follow-up)', async () => {
      const page = await Page.createPage('/repair/redaction-failed-sequence-field', 'v1', user, {});
      const secretValue = 'someone-secret@example.com';
      // Missing `operationId` — `assertWellFormedPendingEntry` rejects this
      // regardless, landing the Page in `failed[]`. `repairPendingEntries`
      // builds that report entry from the BATCH query's `.lean()` snapshot
      // of `pendingHistoryEntry` — no schema casting applied — so a
      // native-driver-corrupted `sequence` field on it must never be copied
      // through into the reported `sequence` verbatim.
      await claimOutbox(page._id, { type: 'content_revision', revisionId: new Types.ObjectId(), sequence: 1, occurredAt: new Date() });
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.sequence': secretValue } });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.sequence).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain(secretValue);

      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a page_event upsert colliding on {page, operationId, kind} with an existing DIFFERENT-_id event surfaces a redacted, field-name-only reason — never the raw operationId (codex review attempt 2, round 6)', async () => {
      const page = await Page.createPage('/repair/redaction-e11000-operationid', 'v1', user, {});
      const secretOperationId = 'someone-secret@example.com';
      // A pre-existing event already occupies `{page, operationId, kind}` —
      // the compound unique index (`pageHistoryEvent_page_operationId_kind_unique`).
      await PageHistoryEvent.create({
        page: page._id,
        sequence: 3,
        kind: 'page_created',
        actor: user._id,
        occurredAt: new Date(),
        operationId: secretOperationId,
        source: 'web',
        payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
      });

      // A DIFFERENT `_id` claims the SAME {page, operationId, kind} — the
      // `_id` upsert filter doesn't match the pre-existing row, so this
      // reaches the INSERT path and collides with the compound unique index
      // instead — a raw MongoServerError (E11000), not a Mongoose
      // ValidationError/CastError/StrictModeError.
      const newEventId = new Types.ObjectId();
      await claimOutbox(page._id, {
        type: 'page_event',
        event: {
          _id: newEventId,
          page: page._id,
          sequence: 4,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: secretOperationId,
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain(secretOperationId);
      expect(failure?.reason).toContain('operationId');
      expect(failure?.reason).toContain('[redacted]');
      // Never materialized under the new _id — the write was rejected.
      expect(await PageHistoryEvent.countDocuments({ _id: newEventId })).toBe(0);

      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a native-driver-injected, secret-shaped historySequence on a Revision is never surfaced in the structured `duplicateSequence`/`failed` fields (codex review attempt 2, round 6)', async () => {
      const page = await createReadyPage('/repair/redaction-nonnumeric-historysequence', 'v1');
      const secretValue = 'someone-secret@example.com';
      const r0 = await Revision.findOne({ page: page._id }).exec();
      // Native driver bypass — `historySequence` is a native `.lean()` read
      // inside `scanOneReadyPage`, with NO schema casting; a corrupted
      // non-numeric value survives unchanged and must never flow into a
      // `number`-typed report field.
      await Revision.collection.updateOne({ _id: r0._id }, { $set: { historySequence: secretValue } });

      const result = await scanUnsequencedRevisions(crowi);
      expect(JSON.stringify(result.blocked)).not.toContain(secretValue);
      expect(JSON.stringify(result.repaired)).not.toContain(secretValue);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain(secretValue);
      expect(failure?.reason).toContain('non-numeric historySequence');
      expect(failure?.reason).toContain('redacted');
    });
  });

  describe('repairPendingEntries — one corrupt Page does not abort the rest of the batch', () => {
    test('a malformed entry on one Page is reported in `failed`, while a valid pending entry on another Page still gets repaired in the SAME pass', async () => {
      const badPage = await Page.createPage('/repair/batch-bad', 'v1', user, {});
      const goodPage = await Page.createPage('/repair/batch-good', 'v1', user, {});

      await claimOutbox(badPage._id, { type: 'content_revision', revisionId: new Types.ObjectId(), sequence: 1, occurredAt: new Date() }); // missing operationId
      const eventId = new Types.ObjectId();
      await claimOutbox(goodPage._id, {
        type: 'page_event',
        event: {
          _id: eventId,
          page: goodPage._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-batch-good',
          source: 'web',
          payload: { path: goodPage.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      });

      const result = await repairPendingEntries(crowi);

      expect(result.repairedPageIds).toContain(String(goodPage._id));
      expect(result.repairedPageIds).not.toContain(String(badPage._id));
      expect(result.failed.some((f) => f.pageId === String(badPage._id))).toBe(true);

      const reloadedGood = await Page.findById(goodPage._id);
      expect(reloadedGood.pendingHistoryEntry).toBeUndefined();
      const reloadedBad = await Page.findById(badPage._id);
      expect(reloadedBad.pendingHistoryEntry).toBeDefined();
    });
  });

  describe('drainPendingHistoryEntry — entryId-matched marker clearing (AC-5b, spec revision)', () => {
    /**
     * The spec revision replaced content-based drain matching entirely:
     * `drainPendingHistoryEntry` now matches ONLY on
     * `{ _id: pageId, 'pendingHistoryEntry.entryId': entry.entryId }` — see
     * `models/page.ts`'s `PendingHistoryEntry` doc comment and
     * `materialize.ts`'s module doc comment. AC-5b's two claims:
     * (a) a mismatched `entryId` never clears the slot, even when a
     *     replacement entry occupies it (the case a stale caller must not
     *     erase); and (b) an untracked, schema-unknown field injected via the
     *     native driver never changes the outcome — in EITHER direction: it
     *     must not enable draining a wrong entryId, and it must not block
     *     draining the RIGHT one.
     *
     * The first test below is a related but distinct guard: an entry with NO
     * `entryId` at all is a caller bug (every real entry gets one before it
     * is ever placed), not a legitimate "unscoped" drain — see
     * `drainPendingHistoryEntry`'s doc comment for why this is rejected
     * explicitly rather than left to incidental driver/BSON cast behavior.
     */
    test('an entry with no entryId is rejected outright — never silently drains an unrelated newer entry', async () => {
      const page = await Page.createPage('/repair/drain-missing-entryid', 'v1', user, {});
      const newerEntry = {
        entryId: new Types.ObjectId(),
        type: 'content_revision',
        revisionId: new Types.ObjectId(),
        sequence: 1,
        occurredAt: new Date(),
        operationId: 'op-newer',
      };
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: newerEntry } });

      const entryWithoutId = {
        type: 'content_revision',
        revisionId: new Types.ObjectId(),
        sequence: 99,
        occurredAt: new Date(),
        operationId: 'op-missing-entryid',
      };
      await expect(drainPendingHistoryEntry(crowi, page._id, entryWithoutId as unknown as PendingHistoryEntry)).rejects.toThrow(/missing entryId/);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry?.entryId?.toString()).toBe(newerEntry.entryId.toString());
    });
    test('(a) draining a stale entryId does not clear the slot after it was replaced by a fresh entry, however similar the rest of the fields are', async () => {
      const page = await Page.createPage('/repair/drain-identity-stale', 'v1', user, {});
      const revisionId = new Types.ObjectId();
      // Identical in every field EXCEPT entryId — content equality is no
      // longer relevant to drain identity at all.
      const staleEntry = {
        entryId: new Types.ObjectId(),
        type: 'content_revision',
        revisionId,
        sequence: 3,
        occurredAt: new Date('2020-01-01T00:00:00.000Z'),
        operationId: 'op-repositioned',
      };
      const newerEntry = { ...staleEntry, entryId: new Types.ObjectId() };

      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: newerEntry } });

      const result = await drainPendingHistoryEntry(crowi, page._id, staleEntry);
      expect(result.drained).toBe(false);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry?.entryId?.toString()).toBe(newerEntry.entryId.toString());

      // Good citizenship: this test deliberately leaves a `content_revision`
      // entry pointing at a NON-existent Revision id (`newerEntry`) in the
      // outbox to prove the entryId-mismatch guard above. Left un-drained,
      // that fake entry would poison every later `scanUnsequencedRevisions`
      // pass in this SAME shared test database (`claimAndAssignSequence`
      // reaches into ANY occupied slot it finds to drain it before
      // claiming) — repair.ts is resilient to that (see the `failed`-
      // reporting tests above), but there is no reason to leave a landmine
      // for later tests when cleaning up costs one call.
      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('(b) draining with the CORRECT entryId still clears the slot even when a native-driver-injected, schema-unknown field is present — content is never compared', async () => {
      const page = await Page.createPage('/repair/drain-identity-extra-field', 'v1', user, {});
      const revisionId = new Types.ObjectId();
      const entry = {
        entryId: new Types.ObjectId(),
        type: 'content_revision',
        revisionId,
        sequence: 5,
        occurredAt: new Date('2024-01-01T00:00:00.000Z'),
        operationId: 'op-extra-field',
      };
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: entry } });

      // Bypass Mongoose's schema entirely (native driver) to attach a field
      // this schema declares nowhere — under content-based matching this
      // would have been a threat (an unknown field the filter can't rule
      // out); under entryId-only matching it is simply irrelevant.
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.injectedUnknownField': 'x' } });

      const result = await drainPendingHistoryEntry(crowi, page._id, entry);
      expect(result.drained).toBe(true);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
    });

    test('(b, page_event) draining with the CORRECT entryId still clears the slot even when the nested payload gained a native-driver-injected, schema-unknown field', async () => {
      const page = await Page.createPage('/repair/drain-identity-extra-payload-field', 'v1', user, {});
      const eventId = new Types.ObjectId();
      const entry = {
        entryId: new Types.ObjectId(),
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 6,
          kind: 'page_created' as const,
          actor: user._id,
          occurredAt: new Date('2024-01-01T00:00:00.000Z'),
          operationId: 'op-extra-payload',
          source: 'web' as const,
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      };
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: entry } });

      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.event.payload.injectedUnknownField': 'x' } });

      const result = await drainPendingHistoryEntry(crowi, page._id, entry);
      expect(result.drained).toBe(true);

      const reloaded = await Page.findById(page._id);
      expect(reloaded.pendingHistoryEntry).toBeUndefined();
    });

    /**
     * (codex review attempt 5/2, AC-5b) — the two "(b)" tests above call
     * `drainPendingHistoryEntry` directly with an `entry` object the TEST
     * itself constructed, never re-reading the outbox slot after the native-
     * driver injection. That proves the drain filter's identity semantics in
     * isolation, but never exercises the actual production entrypoint
     * (`materializePendingEntry`, what `repair.ts` calls) reading the
     * INJECTED entry back off the database and carrying it all the way
     * through materialize + drain. These two do that: claim via the same
     * `claimOutbox` helper every other test in this file uses, inject the
     * extra field via the native driver, then call `materializePendingEntry`
     * — not `drainPendingHistoryEntry` — end to end.
     */
    test('(b, end-to-end via materializePendingEntry) a native-driver-injected, schema-unknown field on the claimed content_revision entry does not prevent materialize+drain', async () => {
      const page = await Page.createPage('/repair/drain-identity-e2e-content-revision', 'v1', user, {});
      const revision = await Revision.create({ page: page._id, path: page.path, body: 'v2', format: 'markdown', author: user._id, createdAt: new Date() });
      await claimOutbox(page._id, {
        type: 'content_revision',
        revisionId: revision._id,
        sequence: 8,
        occurredAt: new Date(),
        operationId: 'op-e2e-extra-field',
      });

      // Bypass Mongoose's schema entirely (native driver) to attach a field
      // this schema declares nowhere onto the ALREADY-CLAIMED entry — the
      // exact entry `materializePendingEntry` is about to re-read off the
      // database.
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.injectedUnknownField': 'x' } });

      const result = await materializePendingEntry(crowi, page._id);
      expect(result.drained).toBe(true);

      const reloadedRevision = await Revision.findById(revision._id).lean();
      expect(reloadedRevision.historySequence).toBe(8);
      expect(reloadedRevision.historyOperationId).toBe('op-e2e-extra-field');
      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.pendingHistoryEntry).toBeUndefined();
    });

    test('(b, page_event, end-to-end via materializePendingEntry) a native-driver-injected, schema-unknown top-level field on the claimed entry does not prevent materialize+drain', async () => {
      const page = await Page.createPage('/repair/drain-identity-e2e-page-event', 'v1', user, {});
      const eventId = new Types.ObjectId();
      await claimOutbox(page._id, {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-e2e-payload-extra',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      });

      // Injected at the TOP-LEVEL `pendingHistoryEntry` path (sibling of
      // `type`/`event`), NOT inside `event.payload`: `pageHistoryEventPayloadSchema`
      // deliberately sets `strict: 'throw'` (AC-2's own contract — see that
      // schema's doc comment) and IS enforced when `materialize.ts`'s
      // `page_event` branch constructs `new PageHistoryEvent(entry.event)`
      // from the claimed entry — an injected field THERE is correctly
      // REJECTED (not silently drained), which is that schema's own
      // defense-in-depth working as designed, not a case this AC-5b test is
      // about. This test's claim is narrower and still meaningful: a
      // schema-unknown field OUTSIDE that strict boundary must not prevent
      // materialize+drain through the real pipeline (matching `entry.event`
      // itself unaffected, and `drainPendingHistoryEntry`'s entryId-only
      // filter never inspecting it either way).
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.injectedUnknownField': 'x' } });

      const result = await materializePendingEntry(crowi, page._id);
      expect(result.drained).toBe(true);

      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(1);
      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.pendingHistoryEntry).toBeUndefined();
    });

    test("(payload, end-to-end via repairPendingEntries) a native-driver-injected, schema-unknown field INSIDE event.payload — the reviewer's original injection point — is REJECTED, not silently drained, with a redacted reason and the outbox left occupied", async () => {
      const page = await Page.createPage('/repair/drain-identity-e2e-page-event-payload-rejected', 'v1', user, {});
      const eventId = new Types.ObjectId();
      await claimOutbox(page._id, {
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-e2e-payload-rejected',
          source: 'web',
          payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      });

      // Same injection point the codex review (attempt 5/2) originally cited
      // (`pendingHistoryEntry.event.payload.<unknown>`) — but run through the
      // real production entrypoint (`repairPendingEntries` ->
      // `materializePendingEntry`) instead of `drainPendingHistoryEntry` in
      // isolation. Unlike the top-level-field cases above,
      // `pageHistoryEventPayloadSchema`'s `strict: 'throw'` (AC-2's own
      // contract) makes `new PageHistoryEvent(entry.event)` reject this
      // synchronously — proving the two AC-5b claims together: a
      // schema-unknown field is IGNORED by entryId-only drain when it sits
      // outside the payload's strict boundary, and CORRECTLY REJECTED (never
      // silently materialized, never left un-redacted in the report) when it
      // sits inside it.
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'pendingHistoryEntry.event.payload.injectedUnknownField': 'x' } });

      const result = await repairPendingEntries(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.reason).not.toContain('"x"');
      expect(failure?.reason).toContain('[redacted]');
      expect(await PageHistoryEvent.countDocuments({ _id: eventId })).toBe(0);
      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.pendingHistoryEntry).toBeDefined();

      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });
  });

  describe('repairPendingEntries — background outbox scan', () => {
    test('a Page with no pending entry is not visited', async () => {
      const page = await Page.createPage('/repair/no-pending', 'v1', user, {});
      const result = await repairPendingEntries(crowi);
      expect(result.repairedPageIds).not.toContain(String(page._id));
    });
  });

  describe('scanUnsequencedRevisions — repair (b): assign sequences to unsequenced Revisions on ready Pages (AC-7)', () => {
    test('assigns sequences in createdAt, _id order and reports each assignment', async () => {
      const page = await createReadyPage('/repair/unsequenced', 'v0');
      const base = Date.now();
      // The initial revision from createPage has no historySequence either
      // — Phase 1 ships no writer that assigns one. Two more, explicitly
      // spaced createdAt values so ordering is deterministic regardless of
      // real wall-clock timing. `r0` is fetched by query (not via
      // `page.revision`, which DC-5's own doc comments warn can be a live
      // Revision Document whose `.toString()` is Mongoose's debug inspect
      // override, not the id string).
      const r0 = await Revision.findOne({ page: page._id }).sort({ createdAt: 1 }).exec();
      const r1 = await Revision.create({
        page: page._id,
        path: page.path,
        body: 'v1',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(base + 10_000),
      });
      const r2 = await Revision.create({
        page: page._id,
        path: page.path,
        body: 'v2',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(base + 20_000),
      });

      const result = await scanUnsequencedRevisions(crowi);
      const thisPage = result.repaired.filter((r) => r.pageId.equals(page._id)).sort((a, b) => a.assignedSequence - b.assignedSequence);

      expect(thisPage.map((r) => r.revisionId.toString())).toEqual([r0._id.toString(), r1._id.toString(), r2._id.toString()]);
      expect(thisPage.map((r) => r.assignedSequence)).toEqual([1, 2, 3]);
      // Each assignment reports WHY, not just that it happened (codex review
      // attempt 3, AC-7/8: "operator report ... `repaired` lacks `reason`").
      expect(thisPage.every((r) => typeof r.reason === 'string' && r.reason.length > 0)).toBe(true);

      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.historySequence).toBe(3);

      const allRevisions = await Revision.find({ page: page._id }).sort({ createdAt: 1 }).lean();
      expect(allRevisions.map((r) => r.historySequence)).toEqual([1, 2, 3]);
    });

    test('a second scan pass over an already-repaired Page assigns nothing further', async () => {
      const page = await createReadyPage('/repair/unsequenced-idempotent', 'v0');
      const first = await scanUnsequencedRevisions(crowi);
      expect(first.repaired.some((r) => r.pageId.equals(page._id))).toBe(true);

      const second = await scanUnsequencedRevisions(crowi);
      expect(second.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);
    });

    test('an untracked Page (no historyTracking.state: ready) is never visited', async () => {
      const page = await createReadyPage('/repair/untracked-not-visited', 'v0');
      await Page.updateOne({ _id: page._id }, { $unset: { historyTracking: '' } });

      const result = await scanUnsequencedRevisions(crowi);
      expect(result.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);
    });

    test('a Revision with an explicit historySequence: null (not merely absent) is still treated as unsequenced and assigned a sequence (codex review attempt 2, round 6, AC-7)', async () => {
      const page = await createReadyPage('/repair/unsequenced-explicit-null', 'v0');
      const r0 = await Revision.findOne({ page: page._id }).exec();
      // Native driver bypass — set historySequence to an EXPLICIT `null`,
      // distinct from simply never having the field. `claimAndAssignSequence`
      // used to treat any non-`undefined` value (including `null`) as
      // "already assigned" and silently skip it forever; the two repair
      // queries (`$ne: null` / `null`) had the same gap.
      await Revision.collection.updateOne({ _id: r0._id }, { $set: { historySequence: null } });

      const result = await scanUnsequencedRevisions(crowi);
      const thisPage = result.repaired.filter((r) => r.pageId.equals(page._id));
      expect(thisPage.map((r) => r.revisionId.toString())).toEqual([r0._id.toString()]);
      expect(thisPage[0].assignedSequence).toBe(1);

      const reloaded = await Revision.findById(r0._id).lean();
      expect(reloaded.historySequence).toBe(1);
    });

    test('two Revisions each explicitly set to historySequence: null are NOT reported as a duplicate — null is not a real sequence value (codex review attempt 2, round 6, AC-7)', async () => {
      const page = await createReadyPage('/repair/unsequenced-explicit-null-not-duplicate', 'v0');
      const r0 = await Revision.findOne({ page: page._id }).exec();
      const r1 = await Revision.create({ page: page._id, path: page.path, body: 'v1', format: 'markdown', author: user._id, createdAt: new Date() });
      await Revision.collection.updateOne({ _id: r0._id }, { $set: { historySequence: null } });
      await Revision.collection.updateOne({ _id: r1._id }, { $set: { historySequence: null } });

      const result = await scanUnsequencedRevisions(crowi);
      expect(result.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);
      const thisPage = result.repaired.filter((r) => r.pageId.equals(page._id));
      expect(thisPage.map((r) => r.revisionId.toString()).sort()).toEqual([r0._id.toString(), r1._id.toString()].sort());
    });

    test('a claim that reaches a corrupt outbox slot is reported in `failed` with the Revision id it was trying to sequence (codex review attempt 3, AC-7/8)', async () => {
      const page = await createReadyPage('/repair/unsequenced-claim-failure', 'v0');
      const initialRevision = await Revision.findOne({ page: page._id }).exec();
      // `claimAndAssignSequence` finds the slot already occupied and tries to
      // drain it via `materializePendingEntry` before claiming — a malformed
      // entry there (missing `operationId`) makes that drain throw.
      const malformed = { entryId: new Types.ObjectId(), type: 'content_revision', revisionId: new Types.ObjectId(), sequence: 1, occurredAt: new Date() };
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: malformed } });

      const result = await scanUnsequencedRevisions(crowi);
      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.revisionId).toBe(String(initialRevision._id));
      expect(failure?.reason).toMatch(/missing revisionId\/sequence\/operationId\/occurredAt/);
      expect(result.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);
      expect(result.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);

      // Clean up the deliberately-poisoned outbox slot so it doesn't linger
      // for later tests in this shared database.
      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a claim whose CAS succeeds but whose materialize fails afterward is reported in `failed` WITH the sequence the CAS already allocated (codex review attempt 4, AC-7/8)', async () => {
      const page = await createReadyPage('/repair/unsequenced-post-claim-failure', 'v0');
      const initialRevision = await Revision.findOne({ page: page._id }).exec();

      // Intercept THIS PAGE'S claim CAS specifically (the write that both
      // advances `historySequence` and writes the `migration_revision`
      // outbox entry, scoped by `_id` — a single shared test database can
      // have several OTHER ready Pages with their own missing-Revision claim
      // CAS swept into the SAME `scanUnsequencedRevisions()` call, and this
      // must not touch theirs): let it commit for real, then delete the
      // target Revision immediately afterward — simulating "the Revision was
      // deleted/reparented after the CAS but before materialize" (codex
      // review attempt 4's literal suggestion).
      const original = Page.updateOne.bind(Page);
      const spy = jest.spyOn(Page, 'updateOne').mockImplementation((filter, update, ...rest) => {
        const query = original(filter, update, ...rest);
        const isThisPagesClaimCAS = update?.$set?.pendingHistoryEntry?.type === 'migration_revision' && String(filter?._id) === String(page._id);
        if (!isThisPagesClaimCAS) {
          return query;
        }
        const originalExec = query.exec.bind(query);
        query.exec = async (...execArgs) => {
          const execResult = await originalExec(...execArgs);
          if (execResult.modifiedCount === 1) {
            await Revision.deleteOne({ _id: initialRevision._id });
          }
          return execResult;
        };
        return query;
      });

      const result = await scanUnsequencedRevisions(crowi);
      spy.mockRestore();

      const failure = result.failed.find((f) => f.pageId === String(page._id));
      expect(failure).toBeDefined();
      expect(failure?.revisionId).toBe(String(initialRevision._id));
      expect(failure?.sequence).toBe(1);
      expect(failure?.reason).toMatch(/not found \(page/);
      expect(result.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);
      expect(result.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);

      // Clean up the outbox slot the claim left occupied — materialize threw
      // before it could drain the marker — so it doesn't linger for later
      // tests sharing this database.
      await Page.updateOne({ _id: page._id }, { $unset: { pendingHistoryEntry: '' } });
    });
  });

  describe('scanUnsequencedRevisions — repair (c): duplicate sequence is blocked, not auto-repaired (AC-8)', () => {
    test('two Revisions sharing the same historySequence on one Page are reported as blocked, and nothing is assigned to that Page', async () => {
      const page = await createReadyPage('/repair/duplicate-sequence', 'v0');
      const initialRevision = await Revision.findOne({ page: page._id }).exec();
      await Revision.updateOne({ _id: initialRevision._id }, { $set: { historySequence: 5 } });
      const duplicateRevision = await Revision.create({
        page: page._id,
        path: page.path,
        body: 'dup',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
        historySequence: 5,
      });
      // An additional genuinely-unsequenced revision on the SAME page — a
      // blocked page must not partially repair around the corruption.
      const unsequencedSibling = await Revision.create({
        page: page._id,
        path: page.path,
        body: 'sibling',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
      });

      const result = await scanUnsequencedRevisions(crowi);
      const blockedEntry = result.blocked.find((b) => b.pageId.equals(page._id));
      expect(blockedEntry).toBeDefined();
      expect(blockedEntry?.duplicateSequence).toBe(5);
      // `revisionId` (codex review attempt 3, AC-7/8: "`blocked` lacks
      // revision identity") names one of the two Revisions sharing the
      // duplicate — either is a valid report, so accept both.
      expect([initialRevision._id.toString(), duplicateRevision._id.toString()]).toContain(blockedEntry?.revisionId?.toString());
      expect(blockedEntry?.reason).toContain('revision');
      expect(result.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);

      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.historySequence).toBe(0);
      const stillUnsequenced = await Revision.findById(unsequencedSibling._id).lean();
      expect(stillUnsequenced.historySequence).toBeUndefined();
      const original = await Revision.findById(initialRevision._id).lean();
      expect(original.historySequence).toBe(5);
      const duplicate = await Revision.findById(duplicateRevision._id).lean();
      expect(duplicate.historySequence).toBe(5);
    });

    test('a Revision.historySequence colliding with a PageHistoryEvent.sequence on the same Page is also blocked', async () => {
      const page = await createReadyPage('/repair/duplicate-cross-collection', 'v0');
      const initialRevision = await Revision.findOne({ page: page._id }).exec();
      await Revision.updateOne({ _id: initialRevision._id }, { $set: { historySequence: 2 } });
      await PageHistoryEvent.create({
        page: page._id,
        sequence: 2,
        kind: 'page_created',
        actor: user._id,
        occurredAt: new Date(),
        operationId: 'op-cross-collision',
        source: 'web',
        payload: { path: page.path, grant: Page.GRANT_PUBLIC, status: 'published' },
      });

      const result = await scanUnsequencedRevisions(crowi);
      const blockedEntry = result.blocked.find((b) => b.pageId.equals(page._id));
      expect(blockedEntry).toBeDefined();
      expect(blockedEntry?.duplicateSequence).toBe(2);
      // The Revision is the structured `revisionId`; the PageHistoryEvent
      // owner (which has no `revisionId` field to carry it in) still shows
      // up in `reason` (codex review attempt 3, AC-7/8).
      expect(blockedEntry?.revisionId?.toString()).toBe(initialRevision._id.toString());
      expect(blockedEntry?.reason).toContain('page_event');
    });

    test('historySequence counter lagging behind an already-assigned sequence is blocked — allocating from it would manufacture a NEW collision (AC-8)', async () => {
      const page = await createReadyPage('/repair/counter-lag', 'v0');
      const initialRevision = await Revision.findOne({ page: page._id }).exec();
      // Corruption scenario distinct from the two tests above: there is no
      // EXISTING duplicate yet — only one Revision holds `historySequence:
      // 1` — but `Page.historySequence` (the sole next-value allocator,
      // still its default 0) has fallen behind it. Allocating "counter + 1"
      // from here would hand out 1 again to `unsequencedSibling`,
      // MANUFACTURING the very duplicate the scan exists to prevent.
      await Revision.updateOne({ _id: initialRevision._id }, { $set: { historySequence: 1 } });
      const unsequencedSibling = await Revision.create({
        page: page._id,
        path: page.path,
        body: 'sibling',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
      });

      const result = await scanUnsequencedRevisions(crowi);
      const blockedEntry = result.blocked.find((b) => b.pageId.equals(page._id));
      expect(blockedEntry).toBeDefined();
      expect(blockedEntry?.duplicateSequence).toBe(1);
      expect(blockedEntry?.revisionId?.toString()).toBe(initialRevision._id.toString());
      expect(result.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);

      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.historySequence).toBe(0);
      const stillUnsequenced = await Revision.findById(unsequencedSibling._id).lean();
      expect(stillUnsequenced.historySequence).toBeUndefined();
      const original = await Revision.findById(initialRevision._id).lean();
      expect(original.historySequence).toBe(1);
    });
  });

  describe('scanUnsequencedRevisions — parallel-scan race safety (codex review attempt 3, AC-6/7)', () => {
    test('two concurrent scans over the same Page never duplicate a sequence or leave an orphaned outbox marker, and a follow-up scan converges', async () => {
      const page = await createReadyPage('/repair/parallel-scan-race', 'v0');
      const base = Date.now();
      const r1 = await Revision.create({ page: page._id, path: page.path, body: 'r1', format: 'markdown', author: user._id, createdAt: new Date(base + 1000) });
      const r2 = await Revision.create({ page: page._id, path: page.path, body: 'r2', format: 'markdown', author: user._id, createdAt: new Date(base + 2000) });
      const r3 = await Revision.create({ page: page._id, path: page.path, body: 'r3', format: 'markdown', author: user._id, createdAt: new Date(base + 3000) });

      // Genuine concurrency: both calls race against the SAME live MongoDB
      // connection via Node's event-loop interleaving of their awaits.
      // `null` (= "defer to a future pass") is documented, expected
      // behavior for a claim this call loses within MAX_CLAIM_ATTEMPTS — so
      // this assertion set checks INVARIANTS (no crash, no duplicate, no
      // stuck outbox), not "everything got sequenced by these two calls".
      const [resultA, resultB] = await Promise.all([scanUnsequencedRevisions(crowi), scanUnsequencedRevisions(crowi)]);

      expect(resultA.failed.filter((f) => f.pageId === String(page._id))).toEqual([]);
      expect(resultB.failed.filter((f) => f.pageId === String(page._id))).toEqual([]);
      expect(resultA.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);
      expect(resultB.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);

      const assignedThisPage = [...resultA.repaired, ...resultB.repaired].filter((r) => r.pageId.equals(page._id));
      const assignedSequences = assignedThisPage.map((r) => r.assignedSequence);
      expect(new Set(assignedSequences).size).toBe(assignedSequences.length); // no duplicate sequence assigned across the two racing calls

      const afterRace = await Page.findById(page._id);
      expect(afterRace.pendingHistoryEntry).toBeUndefined(); // never left stuck occupied by the race

      // A follow-up scan must converge: anything neither racing call
      // resolved gets picked up now, with no duplicates.
      const followUp = await scanUnsequencedRevisions(crowi);
      expect(followUp.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);

      const finalRevisions = await Revision.find({ _id: { $in: [r1._id, r2._id, r3._id] } })
        .select('historySequence')
        .lean();
      const finalSequences = finalRevisions.map((r) => r.historySequence);
      expect(finalSequences.every((s) => typeof s === 'number')).toBe(true); // every Revision ended up sequenced
      expect(new Set(finalSequences).size).toBe(finalSequences.length); // still no duplicates after convergence
    });

    test("a Page whose allocator counter and Revision are advanced by a CONCURRENT claim between this scan's batch fetch and its per-page turn is not falsely blocked (codex review attempt 5/2, AC-7/8)", async () => {
      const page = await createReadyPage('/repair/counter-race-not-falsely-blocked', 'v0');
      const initialRevision = await Revision.findOne({ page: page._id }).exec();

      // A controlled (deterministic) reproduction of the race a live two-scan
      // repro exposed: intercept the batch query
      // (`Page.find({ 'historyTracking.state': 'ready' })`) and, the instant
      // it resolves — i.e. exactly the moment a batch-time snapshot of this
      // Page's `historySequence` would have been captured — commit a
      // CONCURRENT claim (advance both the allocator and the target
      // Revision to sequence 1, exactly what a real completed
      // `claimAndAssignSequence` leaves behind) BEFORE this Page is ever
      // handed to the per-page scan logic. Before this fix, the allocator
      // check used that stale batch-time snapshot (0) against the freshly-
      // read `revisionRows` (which — reflecting the injected write below —
      // already shows sequence 1), which is exactly backwards: it must
      // false-block a perfectly healthy Page. The fix re-reads the
      // allocator fresh at the point of comparison, so it observes the
      // injected write too and never blocks.
      let injected = false;
      const originalFind = Page.find.bind(Page);
      const spy = jest.spyOn(Page, 'find').mockImplementation((filter, ...rest) => {
        const query = originalFind(filter, ...rest);
        if (injected || filter?.['historyTracking.state'] !== 'ready') {
          return query;
        }
        const originalExec = query.exec.bind(query);
        query.exec = async (...execArgs) => {
          const execResult = await originalExec(...execArgs);
          injected = true;
          await Promise.all([
            Revision.updateOne({ _id: initialRevision._id }, { $set: { historySequence: 1 } }),
            Page.updateOne({ _id: page._id }, { $set: { historySequence: 1 } }),
          ]);
          return execResult;
        };
        return query;
      });

      let result: Awaited<ReturnType<typeof scanUnsequencedRevisions>>;
      try {
        result = await scanUnsequencedRevisions(crowi);
      } finally {
        spy.mockRestore();
      }

      expect(result.blocked.some((b) => b.pageId.equals(page._id))).toBe(false);
      expect(result.failed.filter((f) => f.pageId === String(page._id))).toEqual([]);
      // The Revision was already sequenced by the injected concurrent claim
      // — nothing was left for THIS scan to assign.
      expect(result.repaired.some((r) => r.pageId.equals(page._id))).toBe(false);

      const reloadedRevision = await Revision.findById(initialRevision._id).lean();
      expect(reloadedRevision.historySequence).toBe(1);
      const reloadedPage = await Page.findById(page._id);
      expect(reloadedPage.historySequence).toBe(1);
    });
  });

  describe('repairPendingEntries — bounded, resumable batching (codex review attempt 3, implementation map)', () => {
    async function claimPageEventOutbox(pageId, operationId: string) {
      const eventId = new Types.ObjectId();
      await claimOutbox(pageId, {
        type: 'page_event',
        event: {
          _id: eventId,
          page: pageId,
          sequence: 1,
          kind: 'page_created',
          actor: user._id,
          occurredAt: new Date(),
          operationId,
          source: 'web',
          payload: { path: '/repair/batching', grant: Page.GRANT_PUBLIC, status: 'published' },
        },
      });
      return eventId;
    }

    test('a batchSize smaller than the pending set still repairs every Page (multiple internal batches)', async () => {
      const pages = await Promise.all(Array.from({ length: 5 }, (_, i) => Page.createPage(`/repair/batching-multi-${i}`, 'v1', user, {})));
      for (const [i, page] of pages.entries()) {
        await claimPageEventOutbox(page._id, `op-batching-multi-${i}`);
      }

      const result = await repairPendingEntries(crowi, { batchSize: 2 });

      expect(result.repairedPageIds).toEqual(expect.arrayContaining(pages.map((p) => String(p._id))));
      for (const page of pages) {
        const reloaded = await Page.findById(page._id);
        expect(reloaded.pendingHistoryEntry).toBeUndefined();
      }
    });

    test('resumeAfterId only visits Pages with a strictly greater _id, leaving earlier ones untouched', async () => {
      const earlier = await createReadyPage('/repair/batching-resume-earlier', 'v1');
      await claimPageEventOutbox(earlier._id, 'op-batching-resume-earlier');
      const later = await createReadyPage('/repair/batching-resume-later', 'v1');
      await claimPageEventOutbox(later._id, 'op-batching-resume-later');

      const result = await repairPendingEntries(crowi, { resumeAfterId: earlier._id });

      expect(result.repairedPageIds).not.toContain(String(earlier._id));
      expect(result.repairedPageIds).toContain(String(later._id));

      const reloadedEarlier = await Page.findById(earlier._id);
      expect(reloadedEarlier.pendingHistoryEntry).toBeDefined(); // untouched — resumed past it
      const reloadedLater = await Page.findById(later._id);
      expect(reloadedLater.pendingHistoryEntry).toBeUndefined();

      // Clean up the deliberately-skipped page so it doesn't linger as a
      // pending entry for later tests in this shared database.
      await Page.updateOne({ _id: earlier._id }, { $unset: { pendingHistoryEntry: '' } });
    });

    test('a non-positive batchSize is rejected before any work runs, instead of silently defeating the bounded-scan guarantee (MongoDB `limit(0)` is unbounded) (advisory)', async () => {
      await expect(repairPendingEntries(crowi, { batchSize: 0 })).rejects.toThrow(/batchSize must be a positive integer/);
      await expect(repairPendingEntries(crowi, { batchSize: -1 })).rejects.toThrow(/batchSize must be a positive integer/);
      await expect(repairPendingEntries(crowi, { batchSize: 1.5 })).rejects.toThrow(/batchSize must be a positive integer/);
    });
  });

  describe('scanUnsequencedRevisions — bounded, resumable batching (codex review attempt 3, implementation map)', () => {
    test('a batchSize smaller than the ready-Page set still scans every Page (multiple internal batches)', async () => {
      const pages = await Promise.all(Array.from({ length: 5 }, (_, i) => createReadyPage(`/repair/scan-batching-multi-${i}`, 'v0')));

      const result = await scanUnsequencedRevisions(crowi, { batchSize: 2 });

      const repairedPageIds = result.repaired.map((r) => String(r.pageId));
      for (const page of pages) {
        expect(repairedPageIds).toContain(String(page._id));
      }
    });

    test('resumeAfterId only visits ready Pages with a strictly greater _id, leaving earlier ones unscanned', async () => {
      const earlier = await createReadyPage('/repair/scan-batching-resume-earlier', 'v0');
      const later = await createReadyPage('/repair/scan-batching-resume-later', 'v0');

      const result = await scanUnsequencedRevisions(crowi, { resumeAfterId: earlier._id });

      const repairedPageIds = result.repaired.map((r) => String(r.pageId));
      expect(repairedPageIds).not.toContain(String(earlier._id));
      expect(repairedPageIds).toContain(String(later._id));

      const reloadedEarlier = await Page.findById(earlier._id);
      expect(reloadedEarlier.historySequence).toBe(0); // untouched — resumed past it
    });

    test('a non-positive batchSize is rejected before any work runs (advisory, codex review attempt 2, round 6)', async () => {
      await expect(scanUnsequencedRevisions(crowi, { batchSize: 0 })).rejects.toThrow(/batchSize must be a positive integer/);
      await expect(scanUnsequencedRevisions(crowi, { batchSize: -1 })).rejects.toThrow(/batchSize must be a positive integer/);
      await expect(scanUnsequencedRevisions(crowi, { batchSize: 1.5 })).rejects.toThrow(/batchSize must be a positive integer/);
    });
  });
});
