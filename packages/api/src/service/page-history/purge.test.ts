import { Types } from 'mongoose';
import { PageCleanupIncompleteError } from 'src/models/page';
import { crowi, Fixture } from 'src/test/setup';
import { PageHistoryPurgeError, purgePageHistoryEvents } from './purge';

/** Walks `.cause` (single error or array, per `PageCleanupIncompleteError`'s own aggregation shape) to collect every message reachable in the chain. */
function collectCauseMessages(err: unknown, acc: string[] = []): string[] {
  if (Array.isArray(err)) {
    for (const item of err) collectCauseMessages(item, acc);
    return acc;
  }
  if (err instanceof Error) {
    acc.push(err.message);
    if ('cause' in err && err.cause !== undefined) {
      collectCauseMessages(err.cause, acc);
    }
  }
  return acc;
}

/**
 * RFC-0021 §5.1/§5.6 (Phase A) — the deletion path has to purge
 * `PageHistoryEvent` rows before any writer ever creates one (Phase B/C),
 * or the first row ever written becomes durably orphaned the moment its
 * Page is hard-deleted.
 *
 * Covers: idempotent purge (AC-26), hard-delete purges all rows (AC-11),
 * a failed purge does not skip sibling cleanup and is reported as a single
 * aggregated error (AC-21), a failed Revision cleanup does not skip the
 * purge either — including when both fail at once (AC-22), and a failure
 * recursively surfaced through `removeRedirectOriginPageByPath` still
 * reaches the same aggregation instead of being swallowed as "origin page
 * doesn't exist".
 */
describe('service/page-history/purge (feature-page-history-phase2c1-metadata-events, Phase A)', () => {
  let Page;
  let Revision;
  let PageHistoryEvent;
  let Activity;
  let user;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    Activity = crowi.model('Activity');
    await PageHistoryEvent.syncIndexes();

    const [testUser] = await Fixture.generate('User', [{ name: 'Purge Tester', username: 'purge-tester', email: 'purge-tester@example.com' }]);
    user = testUser;
  });

  const createVisibilityChangedEvent = (pageId, sequence, overrides: Record<string, unknown> = {}) =>
    PageHistoryEvent.create({
      page: pageId,
      sequence,
      kind: 'visibility_changed',
      actor: user._id,
      occurredAt: new Date(),
      operationId: `op-purge-${pageId}-${sequence}`,
      source: 'web',
      payload: { fromGrant: 1, toGrant: 4 },
      ...overrides,
    });

  describe('purgePageHistoryEvents', () => {
    test('AC-26: is idempotent — a second call on the same pageId finds nothing and returns deletedCount 0 without throwing', async () => {
      const page = await Page.createPage('/purge/idempotent', 'v1', user, {});
      await createVisibilityChangedEvent(page._id, 1);
      await createVisibilityChangedEvent(page._id, 2);

      const first = await purgePageHistoryEvents(crowi, page._id);
      expect(first.deletedCount).toBe(2);
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);

      const second = await purgePageHistoryEvents(crowi, page._id);
      expect(second.deletedCount).toBe(0);
    });

    test('a pageId with no events returns deletedCount 0', async () => {
      const result = await purgePageHistoryEvents(crowi, new Types.ObjectId());
      expect(result.deletedCount).toBe(0);
    });

    test('a driver failure is wrapped in PageHistoryPurgeError, message carries only pageId, and the raw failure is preserved as cause', async () => {
      const pageId = new Types.ObjectId();
      const spy = jest.spyOn(PageHistoryEvent, 'deleteMany').mockImplementationOnce(
        () =>
          ({
            exec: () => Promise.reject(new Error('MARKER_DRIVER_DETAIL_XYZ')),
          }) as unknown as ReturnType<typeof PageHistoryEvent.deleteMany>,
      );

      try {
        try {
          await purgePageHistoryEvents(crowi, pageId);
          throw new Error('expected purgePageHistoryEvents to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(PageHistoryPurgeError);
          expect((err as PageHistoryPurgeError).message).toBe(`page history purge failed for page ${pageId}`);
          expect((err as PageHistoryPurgeError).message).not.toContain('MARKER_DRIVER_DETAIL_XYZ');
          expect((err as Error).cause).toBeInstanceOf(Error);
          expect(((err as Error).cause as Error).message).toBe('MARKER_DRIVER_DETAIL_XYZ');
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Page.completelyDeletePage — purge integration', () => {
    test('AC-11: hard-deleting a page purges every one of its history events', async () => {
      const page = await Page.createPage('/purge/hard-delete', 'v1', user, {});
      await createVisibilityChangedEvent(page._id, 1);
      await createVisibilityChangedEvent(page._id, 2, { operationId: `op-purge-${page._id}-2b` });

      await Page.completelyDeletePage(page, user, { deletion: { mode: 'user_hard_delete', actor: user._id } });

      expect(await Page.findById(page._id)).toBeNull();
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    test('AC-21: a failed purge does not skip Revision/redirect-origin/Activity cleanup or the delete event, and is reported as one aggregated error', async () => {
      const page = await Page.createPage('/purge/aggregate-purge-failure', 'v1', user, {});
      await createVisibilityChangedEvent(page._id, 1);

      const revisionSpy = jest.spyOn(Revision, 'removeRevisionsByPageId');
      const redirectOriginSpy = jest.spyOn(Page, 'removeRedirectOriginPageByPath');
      const activitySpy = jest.spyOn(Activity, 'removeByPage');
      const deleteMemorySpy = jest.spyOn(PageHistoryEvent, 'deleteMany').mockImplementationOnce(
        () =>
          ({
            exec: () => Promise.reject(new Error('MARKER_PURGE_FAILURE')),
          }) as unknown as ReturnType<typeof PageHistoryEvent.deleteMany>,
      );

      const pageEvent = crowi.event('Page');
      const deleteListener = jest.fn();
      pageEvent.once('delete', deleteListener);

      try {
        let caught: unknown;
        try {
          await Page.completelyDeletePage(page, user, { deletion: { mode: 'user_hard_delete', actor: user._id } });
          throw new Error('expected completelyDeletePage to throw');
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(PageCleanupIncompleteError);
        expect((caught as PageCleanupIncompleteError).steps).toContain('history-events');
        expect((caught as PageCleanupIncompleteError).message).not.toContain('MARKER_PURGE_FAILURE');

        // The Page row is gone regardless of the purge failure (deleteOne
        // already committed before purge ever runs).
        expect(await Page.findById(page._id)).toBeNull();

        // Every sibling step still ran — a failed purge must not skip any
        // of them. Stringify the ObjectId args (rather than deep-equal the
        // Buffer-backed instances directly) so a `pageData` re-fetched by
        // `removePageById` still compares equal to the original `page`.
        expect(revisionSpy).toHaveBeenCalled();
        expect(String(revisionSpy.mock.calls.at(-1)?.[0])).toBe(String(page._id));
        expect(redirectOriginSpy).toHaveBeenCalledWith(page.path, {
          mode: 'redirect_stub_cleanup',
          actor: user._id,
        });
        expect(activitySpy).toHaveBeenCalled();
        expect(String(activitySpy.mock.calls.at(-1)?.[0])).toBe(String(page._id));
        expect(deleteListener).toHaveBeenCalledTimes(1);

        // Revision cleanup itself succeeded (only the purge failed), so no
        // orphaned Revision is left behind.
        expect(await Revision.countDocuments({ page: page._id })).toBe(0);
      } finally {
        revisionSpy.mockRestore();
        redirectOriginSpy.mockRestore();
        activitySpy.mockRestore();
        deleteMemorySpy.mockRestore();
        pageEvent.removeListener('delete', deleteListener);
      }
    });

    test('AC-22: a failed Revision cleanup does not skip the history-event purge, and the failure is reported in the aggregated error', async () => {
      const page = await Page.createPage('/purge/aggregate-revision-failure', 'v1', user, {});
      await createVisibilityChangedEvent(page._id, 1);

      const revisionSpy = jest.spyOn(Revision, 'removeRevisionsByPageId').mockRejectedValueOnce(new Error('MARKER_REVISION_FAILURE'));

      try {
        let caught: unknown;
        try {
          await Page.completelyDeletePage(page, user, { deletion: { mode: 'user_hard_delete', actor: user._id } });
          throw new Error('expected completelyDeletePage to throw');
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(PageCleanupIncompleteError);
        expect((caught as PageCleanupIncompleteError).steps).toContain('revisions');
        expect((caught as PageCleanupIncompleteError).message).not.toContain('MARKER_REVISION_FAILURE');

        // The purge itself was NOT skipped by the Revision failure.
        expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
      } finally {
        revisionSpy.mockRestore();
      }
    });

    test('AC-22 (concurrent): a Revision cleanup failure and a history-event purge failure at the same time are aggregated into one error, neither skipping the other', async () => {
      const page = await Page.createPage('/purge/aggregate-concurrent-failure', 'v1', user, {});
      await createVisibilityChangedEvent(page._id, 1);

      const revisionSpy = jest.spyOn(Revision, 'removeRevisionsByPageId').mockRejectedValueOnce(new Error('MARKER_REVISION_FAILURE'));
      const deleteManySpy = jest.spyOn(PageHistoryEvent, 'deleteMany').mockImplementationOnce(
        () =>
          ({
            exec: () => Promise.reject(new Error('MARKER_PURGE_FAILURE')),
          }) as unknown as ReturnType<typeof PageHistoryEvent.deleteMany>,
      );

      try {
        let caught: unknown;
        try {
          await Page.completelyDeletePage(page, user, { deletion: { mode: 'user_hard_delete', actor: user._id } });
          throw new Error('expected completelyDeletePage to throw');
        } catch (err) {
          caught = err;
        }

        // Neither mock short-circuited the other — both steps were reached.
        expect(revisionSpy).toHaveBeenCalledTimes(1);
        expect(deleteManySpy).toHaveBeenCalledTimes(1);

        expect(caught).toBeInstanceOf(PageCleanupIncompleteError);
        const outer = caught as PageCleanupIncompleteError;
        expect(outer.steps).toEqual(['revisions', 'history-events']);
        expect(outer.message).not.toContain('MARKER_REVISION_FAILURE');
        expect(outer.message).not.toContain('MARKER_PURGE_FAILURE');

        // A single aggregated error, not two separate throws — both raw
        // causes stay reachable from `.cause` (never from `.message`).
        const causeMessages = collectCauseMessages(outer);
        expect(causeMessages).toEqual(expect.arrayContaining(['MARKER_REVISION_FAILURE', 'MARKER_PURGE_FAILURE']));
      } finally {
        revisionSpy.mockRestore();
        deleteManySpy.mockRestore();
      }
    });

    test('a cleanup failure recursively surfaced through removeRedirectOriginPageByPath reaches the aggregated error instead of being swallowed as "no origin page"', async () => {
      const target = await Page.createPage('/purge/redirect-target', 'v1', user, {});
      const origin = await Page.createPage('/purge/redirect-origin', 'v1', user, {});
      await Page.updatePageProperty(origin, { redirectTo: target.path });

      // Fails only for the origin's own cleanup (reached via the recursive
      // `removePageById` inside `removeRedirectOriginPageByPath`) — the
      // target's own inner cleanup (run first, via `completelyDeletePage`'s
      // own `removePageById`) is unaffected.
      const originalRemoveRevisionsByPageId = Revision.removeRevisionsByPageId.bind(Revision);
      const revisionSpy = jest.spyOn(Revision, 'removeRevisionsByPageId').mockImplementation((pageId) => {
        if (String(pageId) === String(origin._id)) {
          return Promise.reject(new Error('MARKER_ORIGIN_REVISION_FAILURE'));
        }
        return originalRemoveRevisionsByPageId(pageId);
      });

      try {
        let caught: unknown;
        try {
          await Page.completelyDeletePage(target, user, { deletion: { mode: 'user_hard_delete', actor: user._id } });
          throw new Error('expected completelyDeletePage to throw');
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(PageCleanupIncompleteError);
        const outer = caught as PageCleanupIncompleteError;
        expect(outer.steps).toContain('redirect-origin');
        expect(outer.message).not.toContain('MARKER_ORIGIN_REVISION_FAILURE');

        // The target page itself (the recursion's starting point) is gone
        // regardless of the origin's cleanup failure.
        expect(await Page.findById(target._id)).toBeNull();
        // The origin page row is also gone (`Page.deleteOne` inside its own
        // `removePage` ran fine; only its Revision cleanup failed).
        expect(await Page.findById(origin._id)).toBeNull();
      } finally {
        revisionSpy.mockRestore();
      }
    });
  });
});
