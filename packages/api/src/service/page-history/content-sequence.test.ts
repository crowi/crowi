import { Types } from 'mongoose';
import { STATUS_PUBLISHED } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { runReplaceUrl } from 'src/util/replace-url';
import { allocateContentSequence } from './content-sequence';
import * as materializeModule from './materialize';

/**
 * RFC-0021 §D-2/§D-4 (Phase 2a) — `allocateContentSequence` unit/integration
 * coverage: the two conditional writes (promotion + next-sequence), the
 * never-throws contract, outbox drain-before-claim, the separate
 * claim/drain-assist budgets, crash recovery, the §D-10 self-heal against a
 * concurrent sequencer, promotion against a raw legacy Page shape, and the
 * `PageHistoryEvent`/`PageHistoryOperation` zero-writes invariant across all
 * 5 content-writer routes.
 */
describe('service/page-history/content-sequence — allocateContentSequence (RFC-0021 Phase 2a)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let PageHistoryOperation;
  let user;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    PageHistoryOperation = crowi.model('PageHistoryOperation');

    const [testUser] = await Fixture.generate('User', [
      { name: 'Content Sequence Tester', username: 'content-sequence-tester', email: 'content-sequence-tester@example.com' },
    ]);
    user = testUser;
  });

  /**
   * Builds the exact shape `Page.pushRevision` leaves behind right after its
   * OWN pointer write commits, BEFORE the allocator runs (spec §D-1): an
   * `untracked` Page whose `revision` already points at a freshly-created,
   * unsequenced Revision.
   */
  const createUntrackedPageWithRevision = async (path: string, body = 'v0') => {
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
    const revision = await Revision.create({ page: page._id, path, body, format: 'markdown', author: user._id });
    await Page.updateOne({ _id: page._id }, { $set: { revision: revision._id } });
    return { pageId: page._id, revisionId: revision._id };
  };

  /** Builds a `ready` Page already at `historySequence: n`, with an empty outbox. */
  const createReadyPage = async (path: string, n = 0) => {
    const { pageId } = await createUntrackedPageWithRevision(path, 'seed');
    await Page.updateOne({ _id: pageId }, { $set: { historyTracking: { state: 'ready', trackingStartedAt: new Date() }, historySequence: n } });
    return pageId;
  };

  const createRevision = async (pageId: unknown, body: string) => {
    const page = await Page.findById(pageId).select('path').lean();
    return Revision.create({ page: pageId, path: page.path, body, format: 'markdown', author: user._id });
  };

  /**
   * Stages an occupied outbox entry AND advances `Page.historySequence` to
   * match it — the real §D-4 CAS always advances both together in the SAME
   * write, so a fixture that stages only the entry (leaving the counter
   * behind) would describe a Page state the allocator itself can never
   * produce.
   */
  const stageOutboxEntry = async (pageId: unknown, revisionId: unknown, sequence: number, operationId: string) => {
    await Page.updateOne(
      { _id: pageId },
      {
        $set: {
          historySequence: sequence,
          pendingHistoryEntry: {
            entryId: new Types.ObjectId(),
            type: 'content_revision',
            revisionId,
            sequence,
            occurredAt: new Date(),
            operationId,
          },
        },
      },
    );
  };

  describe('promotion: untracked -> ready (§D-4a)', () => {
    test('promotes the Page to ready and assigns sequence 1 to the Revision the pointer already points at', async () => {
      const { pageId, revisionId } = await createUntrackedPageWithRevision('/content-sequence/promote');

      const outcome = await allocateContentSequence(crowi, pageId, revisionId);

      expect(outcome).toEqual({ allocated: true, sequence: 1, materialized: true, alreadySequenced: false });

      const page = await Page.findById(pageId);
      expect(page.historyTracking.state).toBe('ready');
      expect(page.historySequence).toBe(1);
      expect(page.pendingHistoryEntry).toBeUndefined();
      expect(page.historyTracking.trackingStartedAt).toBeInstanceOf(Date);

      // AC-17 — the outbox entry carried occurredAt + a non-null operationId
      // all the way through materialize without throwing.
      const revision = await Revision.findById(revisionId).lean();
      expect(revision?.historySequence).toBe(1);
      expect(typeof revision?.historyOperationId).toBe('string');
      expect((revision?.historyOperationId as string).length).toBeGreaterThan(0);
    });

    test('is not-eligible when the given revisionId does not match the untracked Page current pointer', async () => {
      const { pageId } = await createUntrackedPageWithRevision('/content-sequence/promote-mismatch');
      const foreignRevisionId = new Types.ObjectId();

      const outcome = await allocateContentSequence(crowi, pageId, foreignRevisionId);

      expect(outcome).toEqual({ allocated: false, reason: 'not-eligible' });
      const page = await Page.findById(pageId);
      expect(page.historyTracking.state).toBe('untracked');
      expect(page.historySequence).toBe(0);
    });

    test('promotes a Page whose raw document predates the historySequence/historyTracking schema fields entirely', async () => {
      // A genuinely legacy raw document (inserted via the native driver, the
      // same shape a pre-Phase-1 Crowi row has): `historySequence` /
      // `historyTracking` are NOT present at all — not "present with the
      // default value", literally absent from storage. Mongoose hydration
      // reads these back as their schema defaults (`0` / `{ state:
      // 'untracked', ... }`), but the promotion CAS is a raw MongoDB filter
      // that must ALSO treat "field missing" as eligible, or a Page in this
      // shape can never be promoted by any writer whose own pointer write is
      // a raw `updateOne` (collab) rather than a full document `.save()`.
      const insertResult = await Page.collection.insertOne({
        path: '/content-sequence/legacy-raw-fields',
        status: STATUS_PUBLISHED,
        grant: Page.GRANT_PUBLIC,
        creator: user._id,
        lastUpdateUser: user._id,
        grantedUsers: [user._id],
        createdAt: new Date(),
      });
      const pageId = insertResult.insertedId;
      const revision = await Revision.create({
        page: pageId,
        path: '/content-sequence/legacy-raw-fields',
        body: 'legacy',
        format: 'markdown',
        author: user._id,
      });
      // Mirrors collab's own pointer write (`save-flow.ts` step 5b): a raw
      // `updateOne` that sets ONLY the pointer fields, never touching
      // `historySequence` / `historyTracking` — the exact write shape that
      // leaves those fields permanently absent from storage.
      await Page.updateOne(
        { _id: pageId },
        { $set: { revision: revision._id, currentRevision: revision._id, lastUpdateUser: user._id, updatedAt: new Date() } },
      );

      const outcome = await allocateContentSequence(crowi, pageId, revision._id);

      expect(outcome).toEqual({ allocated: true, sequence: 1, materialized: true, alreadySequenced: false });
      const page = await Page.findById(pageId);
      expect(page.historyTracking.state).toBe('ready');
      expect(page.historySequence).toBe(1);
      const reloadedRevision = await Revision.findById(revision._id).lean();
      expect(reloadedRevision?.historySequence).toBe(1);
    });

    test('promotes a Page whose raw historyTracking subdocument is present but is missing `state` (a partial write, not a field entirely absent)', async () => {
      // Distinct from the "predates the schema fields entirely" case above:
      // here `historyTracking` DOES exist in storage as `{}`, so a filter of
      // only `{ historyTracking: null }` (matching the WHOLE path being
      // absent) would never match this shape — only a filter on the LEAF
      // path `historyTracking.state` catches both "subdocument absent" and
      // "subdocument present, state absent".
      const insertResult = await Page.collection.insertOne({
        path: '/content-sequence/legacy-partial-tracking',
        status: STATUS_PUBLISHED,
        grant: Page.GRANT_PUBLIC,
        creator: user._id,
        lastUpdateUser: user._id,
        grantedUsers: [user._id],
        createdAt: new Date(),
        historySequence: 0,
        historyTracking: {},
      });
      const pageId = insertResult.insertedId;
      const revision = await Revision.create({
        page: pageId,
        path: '/content-sequence/legacy-partial-tracking',
        body: 'legacy-partial',
        format: 'markdown',
        author: user._id,
      });
      await Page.updateOne(
        { _id: pageId },
        { $set: { revision: revision._id, currentRevision: revision._id, lastUpdateUser: user._id, updatedAt: new Date() } },
      );

      const outcome = await allocateContentSequence(crowi, pageId, revision._id);

      expect(outcome).toEqual({ allocated: true, sequence: 1, materialized: true, alreadySequenced: false });
      const page = await Page.findById(pageId);
      expect(page.historyTracking.state).toBe('ready');
      expect(page.historySequence).toBe(1);
      const reloadedRevision = await Revision.findById(revision._id).lean();
      expect(reloadedRevision?.historySequence).toBe(1);
    });
  });

  describe('next sequence on a ready Page (§D-4b)', () => {
    test('assigns the next sequence and drains the outbox', async () => {
      const pageId = await createReadyPage('/content-sequence/next', 3);
      const revision = await createRevision(pageId, 'v4');

      const outcome = await allocateContentSequence(crowi, pageId, revision._id);

      expect(outcome).toEqual({ allocated: true, sequence: 4, materialized: true, alreadySequenced: false });
      const page = await Page.findById(pageId);
      expect(page.historySequence).toBe(4);
      expect(page.pendingHistoryEntry).toBeUndefined();
      const reloadedRevision = await Revision.findById(revision._id).lean();
      expect(reloadedRevision?.historySequence).toBe(4);
    });
  });

  describe('AC-16: a Revision that already carries a sequence is a no-op', () => {
    test('does not consume a new sequence, and never touches the Page counter or outbox', async () => {
      const pageId = await createReadyPage('/content-sequence/already-sequenced', 5);
      const revision = await createRevision(pageId, 'v6');
      const first = await allocateContentSequence(crowi, pageId, revision._id);
      expect(first).toEqual({ allocated: true, sequence: 6, materialized: true, alreadySequenced: false });

      const second = await allocateContentSequence(crowi, pageId, revision._id);

      expect(second).toEqual({ allocated: true, sequence: 6, materialized: true, alreadySequenced: true });
      const page = await Page.findById(pageId);
      expect(page.historySequence).toBe(6); // unchanged by the second call
      expect(page.pendingHistoryEntry).toBeUndefined();
    });

    test('does not drain an outbox entry occupied by an UNRELATED Revision (the §D-2 step-1 loop-top check)', async () => {
      const pageId = await createReadyPage('/content-sequence/already-sequenced-with-occupant', 5);
      const revision = await createRevision(pageId, 'v6');
      const first = await allocateContentSequence(crowi, pageId, revision._id);
      expect(first).toEqual({ allocated: true, sequence: 6, materialized: true, alreadySequenced: false });

      // A DIFFERENT in-flight claim now occupies the outbox slot.
      const occupant = await createRevision(pageId, 'occupant');
      await stageOutboxEntry(pageId, occupant._id, 7, 'occupant-op');

      // Re-asking about the ALREADY-sequenced revision must return immediately
      // — before ever reading the Page, let alone draining the occupant.
      const outcome = await allocateContentSequence(crowi, pageId, revision._id);

      expect(outcome).toEqual({ allocated: true, sequence: 6, materialized: true, alreadySequenced: true });
      const page = await Page.findById(pageId);
      expect(page.historySequence).toBe(7); // unchanged by this call — still the occupant's staged value
      expect(page.pendingHistoryEntry).toBeDefined(); // the occupant's entry is untouched, not drained
      const reloadedOccupant = await Revision.findById(occupant._id).lean();
      expect(reloadedOccupant?.historySequence).toBeUndefined(); // the occupant was never materialized
    });
  });

  describe('AC-9: an occupied outbox is materialized before this call claims its own sequence', () => {
    test('drains the existing entry, then allocates the next sequence for the new Revision', async () => {
      const pageId = await createReadyPage('/content-sequence/drain-then-claim', 1);
      const occupant = await createRevision(pageId, 'occupant');
      await stageOutboxEntry(pageId, occupant._id, 2, 'occupant-op');
      const newRevision = await createRevision(pageId, 'new');

      const outcome = await allocateContentSequence(crowi, pageId, newRevision._id);

      expect(outcome).toEqual({ allocated: true, sequence: 3, materialized: true, alreadySequenced: false });
      const reloadedOccupant = await Revision.findById(occupant._id).lean();
      expect(reloadedOccupant?.historySequence).toBe(2); // the pre-existing entry got materialized
      const reloadedNew = await Revision.findById(newRevision._id).lean();
      expect(reloadedNew?.historySequence).toBe(3);
    });
  });

  describe('AC-13: draining an occupied entry never consumes the claim-attempt budget', () => {
    test('succeeds with a claim budget of 1, even though draining the occupant is a required first step', async () => {
      const pageId = await createReadyPage('/content-sequence/budget-separation', 0);
      const occupant = await createRevision(pageId, 'occupant');
      await stageOutboxEntry(pageId, occupant._id, 1, 'occupant-op');
      const newRevision = await createRevision(pageId, 'new');

      // A single occupied entry costs exactly 1 drain-assist + 1 claim
      // attempt. If the two budgets were folded into one (spec §D-2's
      // rejected alternative), a claim budget of 1 alone would already be
      // exhausted by the drain step and this call would fail.
      const outcome = await allocateContentSequence(crowi, pageId, newRevision._id, { maxClaimAttempts: 1, maxDrainAssists: 1 });

      expect(outcome).toEqual({ allocated: true, sequence: 2, materialized: true, alreadySequenced: false });
    });

    test('two concurrent saves against a Page with an occupied outbox both get distinct sequences, and neither is lost', async () => {
      const pageId = await createReadyPage('/content-sequence/concurrent', 0);
      const occupant = await createRevision(pageId, 'occupant');
      await stageOutboxEntry(pageId, occupant._id, 1, 'occupant-op');
      const revisionA = await createRevision(pageId, 'a');
      const revisionB = await createRevision(pageId, 'b');

      const [outcomeA, outcomeB] = await Promise.all([
        allocateContentSequence(crowi, pageId, revisionA._id),
        allocateContentSequence(crowi, pageId, revisionB._id),
      ]);

      expect(outcomeA.allocated).toBe(true);
      expect(outcomeB.allocated).toBe(true);
      const sequences = [outcomeA, outcomeB].map((o) => (o.allocated ? o.sequence : null));
      expect(new Set(sequences).size).toBe(2);
      expect(sequences.every((s) => s === 2 || s === 3)).toBe(true);

      const reloadedOccupant = await Revision.findById(occupant._id).lean();
      expect(reloadedOccupant?.historySequence).toBe(1);
      const reloadedA = await Revision.findById(revisionA._id).lean();
      const reloadedB = await Revision.findById(revisionB._id).lean();
      expect(new Set([reloadedA?.historySequence, reloadedB?.historySequence])).toEqual(new Set([2, 3]));
    });
  });

  describe('AC-10: recovering from a crash between claim and materialize', () => {
    test('a follow-up call for the NEXT Revision first finishes the stuck entry, then allocates its own sequence', async () => {
      const pageId = await createReadyPage('/content-sequence/interrupted', 4);
      const stuckRevision = await createRevision(pageId, 'stuck');
      // Simulate "claim committed, materialize never ran" — the exact
      // durable state a process crash between §D-2 steps 5 and 6 leaves
      // behind: `Page.historySequence` already advanced + outbox occupied,
      // target Revision still unsequenced.
      await Page.updateOne({ _id: pageId }, { $set: { historySequence: 5 } });
      await stageOutboxEntry(pageId, stuckRevision._id, 5, 'stuck-op');
      const nextRevision = await createRevision(pageId, 'next-after-crash');

      const outcome = await allocateContentSequence(crowi, pageId, nextRevision._id);

      expect(outcome).toEqual({ allocated: true, sequence: 6, materialized: true, alreadySequenced: false });
      const reloadedStuck = await Revision.findById(stuckRevision._id).lean();
      expect(reloadedStuck?.historySequence).toBe(5);
      const reloadedNext = await Revision.findById(nextRevision._id).lean();
      expect(reloadedNext?.historySequence).toBe(6);
    });
  });

  describe('§D-10 self-heal: a Revision durably sequenced by someone else between claim and materialize', () => {
    test('drains its own now-unmaterializable outbox entry instead of jamming, and reports the OTHER sequence', async () => {
      const pageId = await createReadyPage('/content-sequence/self-heal', 9);
      const revision = await createRevision(pageId, 'raced');
      const originalMaterialize = materializeModule.materializePendingEntry;

      // Simulate a concurrent sequencer (repair, past its own grace window)
      // winning the race for the SAME Revision: durably assigns it a
      // DIFFERENT sequence in the gap between our own claim CAS and our own
      // materialize call. `materializePendingEntry`'s `historySequence: null`
      // filter can then never match again for our entry — every future
      // attempt would throw the same way forever without the self-heal.
      const spy = jest.spyOn(materializeModule, 'materializePendingEntry').mockImplementationOnce(async (crowiArg, pageIdArg) => {
        await Revision.updateOne({ _id: revision._id }, { $set: { historySequence: 42, historyOperationId: 'other-writer-op' } });
        return originalMaterialize(crowiArg, pageIdArg);
      });

      let outcome: Awaited<ReturnType<typeof allocateContentSequence>>;
      try {
        outcome = await allocateContentSequence(crowi, pageId, revision._id);
      } finally {
        spy.mockRestore();
      }

      // Reports the OTHER writer's durable sequence, not the one we claimed.
      expect(outcome).toEqual({ allocated: true, sequence: 42, materialized: true, alreadySequenced: true });

      const page = await Page.findById(pageId);
      // The outbox is drained (not jammed) even though OUR claimed sequence
      // (10) was never used by any Revision — a benign, permanent gap.
      expect(page.pendingHistoryEntry).toBeUndefined();
      expect(page.historySequence).toBe(10);

      const reloadedRevision = await Revision.findById(revision._id).lean();
      expect(reloadedRevision?.historySequence).toBe(42);
      expect(reloadedRevision?.historyOperationId).toBe('other-writer-op');
    });

    test('retries the self-heal drain through a transient failure, and still succeeds', async () => {
      const pageId = await createReadyPage('/content-sequence/self-heal-retry', 9);
      const revision = await createRevision(pageId, 'raced');
      const originalMaterialize = materializeModule.materializePendingEntry;
      const originalDrain = materializeModule.drainPendingHistoryEntry;

      const materializeSpy = jest.spyOn(materializeModule, 'materializePendingEntry').mockImplementationOnce(async (crowiArg, pageIdArg) => {
        await Revision.updateOne({ _id: revision._id }, { $set: { historySequence: 42, historyOperationId: 'other-writer-op' } });
        return originalMaterialize(crowiArg, pageIdArg);
      });
      let drainCalls = 0;
      const drainSpy = jest.spyOn(materializeModule, 'drainPendingHistoryEntry').mockImplementation(async (crowiArg, pageIdArg, entryArg) => {
        drainCalls += 1;
        if (drainCalls === 1) {
          throw new Error('injected transient drain failure');
        }
        return originalDrain(crowiArg, pageIdArg, entryArg);
      });

      let outcome: Awaited<ReturnType<typeof allocateContentSequence>>;
      try {
        outcome = await allocateContentSequence(crowi, pageId, revision._id);
      } finally {
        materializeSpy.mockRestore();
        drainSpy.mockRestore();
      }

      expect(outcome).toEqual({ allocated: true, sequence: 42, materialized: true, alreadySequenced: true });
      expect(drainCalls).toBe(2); // first attempt failed, the retry succeeded
      const page = await Page.findById(pageId);
      expect(page.pendingHistoryEntry).toBeUndefined(); // fully cleared despite the transient failure
    });

    test('reports contended (never a false success) and leaves the outbox occupied when every self-heal attempt fails', async () => {
      const pageId = await createReadyPage('/content-sequence/self-heal-exhausted', 9);
      const revision = await createRevision(pageId, 'raced');
      const originalMaterialize = materializeModule.materializePendingEntry;

      const materializeSpy = jest.spyOn(materializeModule, 'materializePendingEntry').mockImplementationOnce(async (crowiArg, pageIdArg) => {
        await Revision.updateOne({ _id: revision._id }, { $set: { historySequence: 42, historyOperationId: 'other-writer-op' } });
        return originalMaterialize(crowiArg, pageIdArg);
      });
      let drainCalls = 0;
      // Counted via a local closure, not `drainSpy.mock.calls` — `mockRestore()`
      // below clears the spy's own call history as a side effect of restoring
      // the original implementation, so an assertion made AFTER that call
      // would always see zero regardless of how many times this actually ran.
      const drainSpy = jest.spyOn(materializeModule, 'drainPendingHistoryEntry').mockImplementation(async () => {
        drainCalls += 1;
        throw new Error('injected permanent drain failure');
      });

      let outcome: Awaited<ReturnType<typeof allocateContentSequence>>;
      try {
        outcome = await allocateContentSequence(crowi, pageId, revision._id);
      } finally {
        materializeSpy.mockRestore();
        drainSpy.mockRestore();
      }

      // Never lies about success — a caller (or a human reading the report
      // repair.ts's `repairPendingEntries` produces on a later scan) must be
      // able to tell this attempt did NOT actually clean up.
      expect(outcome).toEqual({ allocated: false, reason: 'contended' });
      expect(drainCalls).toBe(3); // exhausted the bounded retry budget

      const page = await Page.findById(pageId);
      expect(page.pendingHistoryEntry).toBeDefined(); // left occupied, not silently dropped
      expect(page.historySequence).toBe(10); // the CAS still durably advanced the counter before this failure
    });
  });

  describe('not-eligible states', () => {
    test('a Page in the migrating state is not eligible', async () => {
      const { pageId, revisionId } = await createUntrackedPageWithRevision('/content-sequence/migrating');
      await Page.updateOne({ _id: pageId }, { $set: { 'historyTracking.state': 'migrating' } });

      const outcome = await allocateContentSequence(crowi, pageId, revisionId);
      expect(outcome).toEqual({ allocated: false, reason: 'not-eligible' });
    });

    test('a Page that no longer exists is not eligible', async () => {
      const outcome = await allocateContentSequence(crowi, new Types.ObjectId(), new Types.ObjectId());
      expect(outcome).toEqual({ allocated: false, reason: 'not-eligible' });
    });

    test('a Revision that no longer exists is not eligible', async () => {
      const pageId = await createReadyPage('/content-sequence/revision-gone', 0);
      const outcome = await allocateContentSequence(crowi, pageId, new Types.ObjectId());
      expect(outcome).toEqual({ allocated: false, reason: 'not-eligible' });
    });
  });

  describe('never throws (Error semantics contract)', () => {
    test('an internal DB failure collapses to { allocated: false, reason: "contended" } instead of rejecting', async () => {
      const pageId = await createReadyPage('/content-sequence/db-failure', 0);
      const revision = await createRevision(pageId, 'v');
      const spy = jest.spyOn(Page, 'findById').mockImplementationOnce(() => {
        throw new Error('injected DB failure');
      });

      let outcome: Awaited<ReturnType<typeof allocateContentSequence>>;
      try {
        outcome = await allocateContentSequence(crowi, pageId, revision._id);
      } finally {
        spy.mockRestore();
      }

      expect(outcome).toEqual({ allocated: false, reason: 'contended' });
    });

    test('a throwing accessor on the options object does not reject either', async () => {
      // The two content-save call sites (`models/page.ts`, `util/replace-url.ts`)
      // deliberately have no try/catch around this function, so reading the
      // options must be inside its own guard like everything else — otherwise a
      // caller-supplied getter could reject an already-committed save.
      const pageId = await createReadyPage('/content-sequence/throwing-options', 0);
      const revision = await createRevision(pageId, 'v');
      const hostileOptions = Object.defineProperty({}, 'maxClaimAttempts', {
        get() {
          throw new Error('injected option failure');
        },
      }) as { maxClaimAttempts?: number };

      const outcome = await allocateContentSequence(crowi, pageId, revision._id, hostileOptions);

      expect(outcome).toEqual({ allocated: false, reason: 'contended' });
    });
  });

  describe('AC-7: no PageHistoryEvent / PageHistoryOperation rows are ever created', () => {
    test('across allocator outcomes directly (promotion, next-sequence, already-sequenced, not-eligible)', async () => {
      const { pageId: p1, revisionId: r1 } = await createUntrackedPageWithRevision('/content-sequence/ac7-a');
      await allocateContentSequence(crowi, p1, r1);

      const p2 = await createReadyPage('/content-sequence/ac7-b', 1);
      const r2 = await createRevision(p2, 'v2');
      await allocateContentSequence(crowi, p2, r2._id);
      await allocateContentSequence(crowi, p2, r2._id); // already-sequenced

      await allocateContentSequence(crowi, new Types.ObjectId(), new Types.ObjectId()); // not-eligible

      expect(await PageHistoryEvent.countDocuments({})).toBe(0);
      expect(await PageHistoryOperation.countDocuments({})).toBe(0);
    });

    // spec §D-8's 5 content-writer routes, driven through their OWN entry
    // points (not `allocateContentSequence` directly) — this is the
    // "no writer ever stages a page_event/operation row" invariant, so it
    // must hold at the writer boundary, not just inside the allocator.
    test('across all five §D-8 content-writer routes', async () => {
      // Route 1: normal page create (Page.createPage -> pushRevision, create mode).
      const created = await Page.createPage('/content-sequence/ac7-route1-create', 'v1', user, {});

      // Route 2: draft create — same Page.create + Revision.prepareRevision +
      // Page.pushRevision shape as hono/handlers/draft.ts.
      const draftPage = await Page.create({
        path: '/content-sequence/ac7-route2-draft',
        creator: user._id,
        lastUpdateUser: user._id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        redirectTo: null,
        grant: Page.GRANT_PUBLIC,
        status: 'draft',
        grantedUsers: [user._id],
      });
      const draftRevision = await Revision.prepareRevision(draftPage, 'draft body', user, { format: 'markdown' });
      await Page.pushRevision(draftPage, draftRevision, user);

      // Route 3: HTTP save (Page.updatePage -> pushRevision, update mode).
      await Page.updatePage(created, 'v2', user, {});

      // Route 4: crowi-admin replace url (quietRewrite, via its own public entry point).
      const FROM = 'https://ac7.example';
      const TO = 'https://ac7-new.example';
      await Page.createPage('/content-sequence/ac7-route4-replace-url', `see ${FROM}/x`, user, {});
      await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: user.email });

      // Route 5: collab save — the pointer write is simulated as the exact
      // raw `$set` shape `@crowi/collab`'s `executeSave` issues
      // (save-flow.ts step 5b), followed by the SAME allocator call
      // `packages/api/src/collab/attach.ts` wires in after it (§D-7's
      // ordering). The zero-rows assertion below is only meaningful against
      // this package's own DB, which is why the collab route is simulated
      // here rather than driven through `@crowi/collab` itself.
      const { pageId: collabPageId } = await createUntrackedPageWithRevision('/content-sequence/ac7-route5-collab');
      const collabRevision = await createRevision(collabPageId, 'collab body');
      await Page.updateOne(
        { _id: collabPageId },
        { $set: { revision: collabRevision._id, currentRevision: collabRevision._id, lastUpdateUser: user._id, updatedAt: new Date() } },
      );
      await allocateContentSequence(crowi, collabPageId, collabRevision._id);

      expect(await PageHistoryEvent.countDocuments({})).toBe(0);
      expect(await PageHistoryOperation.countDocuments({})).toBe(0);
    });
  });
});
