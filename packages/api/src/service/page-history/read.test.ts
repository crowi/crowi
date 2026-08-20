import { Types } from 'mongoose';
import { STATUS_PUBLISHED } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { PageHistoryCorruptionError, decodeCursor, projectPendingEntry, readPageHistory } from './read';

/**
 * RFC-0021 Phase 3 — the merged timeline read.
 *
 * Two regions with different ordering rules meet at the tracking boundary, and
 * most of what can go wrong lives at that seam or in the outbox projection.
 */
describe('service/page-history/read (RFC-0021 Phase 3)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let User;
  let user;
  let other;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    User = crowi.model('User');

    const [u1, u2] = await Fixture.generate('User', [
      { name: 'History Reader', username: 'history-reader', email: 'history-reader@example.com' },
      { name: 'History Other', username: 'history-other', email: 'history-other@example.com' },
    ]);
    user = u1;
    other = u2;
  });

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

  /** Append a durable event at the page's next sequence. */
  async function addEvent(page, kind: string, payload: Record<string, unknown>, actor = user._id) {
    const current = await Page.findById(page._id);
    const sequence = (current.historySequence ?? 0) + 1;
    await Page.updateOne({ _id: page._id }, { $set: { historySequence: sequence } });
    return PageHistoryEvent.create({
      page: page._id,
      sequence,
      kind,
      actor,
      occurredAt: new Date(),
      operationId: `op-${page._id}-${sequence}`,
      source: 'web',
      payload,
    });
  }

  const read = (page, limit = 50, cursor = null) => readPageHistory(crowi, { pageId: page._id, limit, cursor });

  describe('AC-1/AC-2: content and events come back as one ordered timeline', () => {
    test('the sequenced region sorts by sequence, then kind, then id', async () => {
      const page = await createReadyPage('/history-read/ac1');
      await addEvent(page, 'visibility_changed', { fromGrant: 1, toGrant: 2 });

      const result = await read(page);

      expect(result.tracking.state).toBe('ready');
      expect(result.entries.map((e) => e.type)).toEqual(['page_event', 'content_revision']);
      // The event took sequence 2; the seed revision holds 1.
      expect(result.entries[0].sequence).toBe(2);
      expect(result.entries[1].sequence).toBe(1);
    });
  });

  describe('AC-3/AC-4: the region below the boundary', () => {
    test('unsequenced revisions come back newest-first with a null sequence', async () => {
      const page = await createReadyPage('/history-read/ac3');
      // A revision written before tracking began: no sequence, older than the boundary.
      const older = await Revision.create({
        path: page.path,
        page: page._id,
        body: 'older',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(Date.now() - 60_000),
      });

      const result = await read(page);

      const row = result.entries.find((e) => e.id === String(older._id));
      expect(row).toBeDefined();
      expect(row.sequence).toBeNull();
    });

    test('AC-4: a revision created exactly at the boundary appears once, not in both regions', async () => {
      const page = await createReadyPage('/history-read/ac4');
      const reloaded = await Page.findById(page._id);
      const boundary = reloaded.historyTracking.trackingStartedAt;

      await Revision.create({
        path: page.path,
        page: page._id,
        body: 'exactly at the boundary',
        format: 'markdown',
        author: user._id,
        createdAt: boundary,
      });

      const result = await read(page);
      const ids = result.entries.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('AC-5/AC-6/AC-7/AC-8: tracking state never fails the read', () => {
    test('AC-5: an untracked page reports every row as unsequenced', async () => {
      const page = await Page.create({
        path: '/history-read/ac5',
        creator: user._id,
        lastUpdateUser: user._id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        redirectTo: null,
        grant: Page.GRANT_PUBLIC,
        status: STATUS_PUBLISHED,
        grantedUsers: [user._id],
      });
      await Revision.create({ path: page.path, page: page._id, body: 'a', format: 'markdown', author: user._id, createdAt: new Date() });

      const result = await read(page);

      expect(result.tracking.state).toBe('untracked');
      expect(result.entries.every((e) => e.sequence === null)).toBe(true);
    });

    test('AC-7: a page left in the retired migrating state still reads', async () => {
      const page = await createReadyPage('/history-read/ac7');
      await Page.collection.updateOne({ _id: page._id }, { $set: { 'historyTracking.state': 'migrating' } });

      const result = await read(await Page.findById(page._id));

      // No boundary can be trusted, so it degrades to time ordering rather than
      // refusing — refusing would leave the history unreachable.
      expect(result.tracking.state).toBe('untracked');
      expect(result.entries.length).toBeGreaterThan(0);
    });

    test('AC-8: a ready page with no recorded start still reads', async () => {
      const page = await createReadyPage('/history-read/ac8');
      await Page.collection.updateOne({ _id: page._id }, { $unset: { 'historyTracking.trackingStartedAt': '' } });

      const result = await read(await Page.findById(page._id));

      expect(result.tracking.state).toBe('untracked');
      expect(result.entries.length).toBeGreaterThan(0);
    });
  });

  describe('AC-11/AC-12: actors', () => {
    test('AC-11: a departed actor is anonymised but the row survives', async () => {
      const page = await createReadyPage('/history-read/ac11');
      await addEvent(page, 'visibility_changed', { fromGrant: 1, toGrant: 2 }, other._id);
      // Deletion tombstones username and email but keeps `name`, so resolving
      // naively would keep publishing it here.
      await User.updateOne({ _id: other._id }, { $set: { status: User.STATUS_DELETED } });

      const result = await read(page);

      const event = result.entries.find((e) => e.type === 'page_event');
      expect(event).toBeDefined();
      expect(event.actor).toBeNull();
    });

    test('AC-12: actors resolve in one query, not one per row', async () => {
      const page = await createReadyPage('/history-read/ac12');
      await addEvent(page, 'visibility_changed', { fromGrant: 1, toGrant: 2 });
      await addEvent(page, 'page_renamed', { fromPath: '/a', toPath: '/b', redirectCreated: false, subtree: false });

      const findSpy = jest.spyOn(crowi.model('User'), 'find');
      let calls: number;
      try {
        await read(page);
      } finally {
        // Read the count BEFORE restoring: `mockRestore` also clears the
        // recorded calls, so asserting afterwards always sees zero.
        calls = findSpy.mock.calls.length;
        findSpy.mockRestore();
      }

      expect(calls).toBe(1);
    });
  });

  describe('AC-13/AC-14: the outbox is projected, never materialized', () => {
    test('a pending event shows up as a row and nothing is written', async () => {
      const page = await createReadyPage('/history-read/ac13');
      const eventId = new Types.ObjectId();
      const marker = {
        entryId: new Types.ObjectId(),
        type: 'page_event',
        event: {
          _id: eventId,
          page: page._id,
          sequence: 5,
          kind: 'visibility_changed',
          actor: user._id,
          occurredAt: new Date(),
          operationId: 'op-pending',
          source: 'web',
          payload: { fromGrant: 1, toGrant: 2 },
        },
      };
      await Page.updateOne({ _id: page._id }, { $set: { pendingHistoryEntry: marker, historySequence: 5 } });
      const eventsBefore = await PageHistoryEvent.countDocuments({ page: page._id });

      const result = await read(await Page.findById(page._id));

      const pending = result.entries.find((e) => e.id === String(eventId));
      expect(pending).toBeDefined();
      expect(pending.pending).toBe(true);

      // AC-14: a read that repaired would make every viewer a writer.
      const after = await Page.collection.findOne({ _id: page._id });
      expect(after.pendingHistoryEntry).not.toBeNull();
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(eventsBefore);
    });

    test('a malformed marker is skipped rather than surfaced', () => {
      expect(projectPendingEntry({ type: 'page_event' })).toBeNull();
      expect(projectPendingEntry({ type: 'page_event', event: { kind: 'not_a_kind', sequence: 1 } })).toBeNull();
      expect(projectPendingEntry(null)).toBeNull();
    });
  });

  describe('AC-19: the upper bound is frozen at the first request', () => {
    test('rows written mid-walk do not appear in a later page', async () => {
      const page = await createReadyPage('/history-read/ac19');
      await addEvent(page, 'visibility_changed', { fromGrant: 1, toGrant: 2 });
      await addEvent(page, 'page_renamed', { fromPath: '/a', toPath: '/b', redirectCreated: false, subtree: false });

      const first = await read(page, 1);
      expect(first.nextCursor).not.toBeNull();

      // A write lands between the two requests.
      await addEvent(page, 'page_trashed', { fromPath: '/b', toPath: '/trash/b' });

      const second = await readPageHistory(crowi, { pageId: page._id, limit: 50, cursor: decodeCursor(first.nextCursor, String(page._id)) });

      expect(second.entries.some((e) => e.type === 'page_event' && e.kind === 'page_trashed')).toBe(false);
    });
  });

  describe('AC-20: a duplicated sequence inside the window is reported, with the page id', () => {
    test('it throws rather than returning a silently reordered timeline', async () => {
      const page = await createReadyPage('/history-read/ac20');
      const event = await addEvent(page, 'visibility_changed', { fromGrant: 1, toGrant: 2 });
      // A revision and an event claiming the same position. The unique index
      // covers events only — it cannot span the two collections, which is
      // precisely why the read has to notice.
      await Revision.create({
        path: page.path,
        page: page._id,
        body: 'collides with the event',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
        historySequence: event.sequence,
      });

      await expect(read(page)).rejects.toThrow(PageHistoryCorruptionError);
      await expect(read(page)).rejects.toThrow(String(page._id));
    });
  });

  describe('AC-22/AC-24: what the read refuses to do', () => {
    test('AC-22: an unsequenced revision above the boundary produces no warning', async () => {
      const page = await createReadyPage('/history-read/ac22');
      // Exactly the state a save in progress produces — the writer saves the
      // revision before the allocator runs.
      await Revision.create({ path: page.path, page: page._id, body: 'in flight', format: 'markdown', author: user._id, createdAt: new Date() });

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(read(page)).resolves.toBeDefined();
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    test('AC-24: only this page is queried for events', async () => {
      const page = await createReadyPage('/history-read/ac24');
      const otherPage = await createReadyPage('/history-read/ac24-other');
      await addEvent(page, 'visibility_changed', { fromGrant: 1, toGrant: 2 });
      await addEvent(otherPage, 'visibility_changed', { fromGrant: 1, toGrant: 2 });

      const findSpy = jest.spyOn(crowi.model('PageHistoryEvent'), 'find');
      let filters: unknown[];
      try {
        await read(page);
      } finally {
        // Snapshot before restoring — `mockRestore` clears the calls, which
        // would leave the loop below iterating nothing and asserting nothing.
        filters = findSpy.mock.calls.map((call) => call[0]);
        findSpy.mockRestore();
      }

      // Grouping a subtree operation must never resolve the other pages it
      // touched — those are authorized independently.
      expect(filters.length).toBeGreaterThan(0);
      for (const filter of filters) {
        expect(String((filter as { page?: unknown })?.page)).toBe(String(page._id));
      }
    });
  });

  describe('cursor validation', () => {
    test('rejects a cursor issued for a different page', () => {
      const pageA = new Types.ObjectId();
      const encoded = Buffer.from(
        JSON.stringify({ v: 1, pageId: String(pageA), upper: 3, region: 'sequenced', boundary: null, after: { sequence: 3, kindRank: 1, id: 'x' } }),
      ).toString('base64url');

      expect(() => decodeCursor(encoded, String(new Types.ObjectId()))).toThrow(/page mismatch/);
    });

    test('rejects malformed, oversized and unsafe-integer cursors', () => {
      const pageId = String(new Types.ObjectId());
      expect(() => decodeCursor('not-base64-json', pageId)).toThrow();
      expect(() => decodeCursor('a'.repeat(600), pageId)).toThrow(/too long/);

      const unsafe = Buffer.from(
        JSON.stringify({ v: 1, pageId, upper: Number.MAX_VALUE, region: 'sequenced', boundary: null, after: { sequence: 1, kindRank: 1, id: 'x' } }),
      ).toString('base64url');
      expect(() => decodeCursor(unsafe, pageId)).toThrow(/bad upper/);

      const wrongVersion = Buffer.from(
        JSON.stringify({ v: 2, pageId, upper: 1, region: 'sequenced', boundary: null, after: { sequence: 1, kindRank: 1, id: 'x' } }),
      ).toString('base64url');
      expect(() => decodeCursor(wrongVersion, pageId)).toThrow(/version/);
    });
  });
});
