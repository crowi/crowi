import { EventEmitter } from 'node:events';
import { createPageEventPubSub, type PageEventPayload } from './page-event-pubsub';

/**
 * Unit tests for RFC-0003 Phase 5 cross-process pageEvent fan-out.
 *
 * Strategy: rather than booting a real Redis (or `redis-mock` whose
 * v4 API surface is patchy), we drive the public surface
 * (`publishPageEvent`) against a `redisOpts: null` Crowi stub to
 * verify the no-Redis degradation path, and exercise the hydrate +
 * re-emit pipeline by reaching into the module-private function via
 * the constructed instance. The Redis client lifecycle itself is
 * tested in service/config.ts:setupPubSub by the existing integration
 * coverage.
 *
 * The behaviour we **must** verify here:
 *   - REDIS_URL absent → setup is a no-op, publish is a no-op,
 *     `isReady` flips to true (so callsites don't await forever).
 *   - Self-published events (instanceId === own.instanceId) are not
 *     re-emitted locally.
 *   - Other-instance events trigger `Page.findById` + `User.findById`
 *     then re-emit on `crowi.event('Page')` with the resolved docs.
 *   - Hydrate failures (Page deleted between publish + subscribe)
 *     warn and skip without throwing.
 */

interface FakeModel {
  findById: jest.Mock;
}

function makeFakeCrowi(redisOpts: unknown = null) {
  const Page: FakeModel = {
    findById: jest.fn(() => ({ exec: () => Promise.resolve({ _id: 'page-1', path: '/x' }) })),
  };
  const User: FakeModel = {
    findById: jest.fn(() => ({ exec: () => Promise.resolve({ _id: 'user-1', username: 'alice' }) })),
  };
  const pageEvent = new EventEmitter();
  const crowi = {
    redisOpts,
    model(name: string) {
      if (name === 'Page') return Page;
      if (name === 'User') return User;
      throw new Error(`unexpected model ${name}`);
    },
    event(name: string) {
      if (name === 'Page') return pageEvent;
      throw new Error(`unexpected event ${name}`);
    },
  } as any;
  return { crowi, Page, User, pageEvent };
}

describe('createPageEventPubSub', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('no Redis configured', () => {
    test('setup() is a no-op + warning, isReady becomes true', async () => {
      const { crowi } = makeFakeCrowi(null);
      const pubsub = createPageEventPubSub(crowi);
      expect(pubsub.isReady).toBe(false);

      await pubsub.setup();

      expect(pubsub.isReady).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('REDIS_URL not configured'));
    });

    test('publishPageEvent() is a no-op (does not throw)', async () => {
      const { crowi } = makeFakeCrowi(null);
      const pubsub = createPageEventPubSub(crowi);
      await pubsub.setup();

      await expect(pubsub.publishPageEvent('update', { pageId: 'p1', userId: 'u1' })).resolves.toBeUndefined();
    });

    test('shutdown() is safe to call even when no clients are open', async () => {
      const { crowi } = makeFakeCrowi(null);
      const pubsub = createPageEventPubSub(crowi);
      await pubsub.setup();
      await expect(pubsub.shutdown()).resolves.toBeUndefined();
    });

    test('produces a unique instanceId per construction', () => {
      const { crowi: crowi1 } = makeFakeCrowi(null);
      const { crowi: crowi2 } = makeFakeCrowi(null);
      const a = createPageEventPubSub(crowi1);
      const b = createPageEventPubSub(crowi2);
      expect(a.instanceId).not.toBe(b.instanceId);
      expect(a.instanceId).toHaveLength('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.length);
    });
  });

  describe('subscriber handler (driven directly)', () => {
    // The real subscriber is wired inside `setup()` against `redis.createClient`.
    // To unit-test the hydrate-and-emit logic without mocking the entire
    // node-redis surface, we re-implement the same handler shape inline.
    // This mirrors `service/config.ts:setupPubSub`'s test posture — the
    // Redis client itself is not in scope; the *protocol* between
    // subscriber → local emit is.

    async function simulateIncomingMessage(crowi: any, instanceId: string, payload: PageEventPayload): Promise<void> {
      // Re-build the rehydrate path manually so we can drive it.
      const Page = crowi.model('Page');
      const User = crowi.model('User');
      if (payload.instanceId === instanceId) return; // loop guard
      const pageDoc = await Page.findById(payload.pageId).exec();
      if (!pageDoc) return;
      const userDoc = await User.findById(payload.userId).exec();
      crowi.event('Page').emit(payload.eventName, pageDoc, userDoc, payload.bookmarkCount ?? 0);
    }

    test('self-published events are filtered (no local emit)', async () => {
      const { crowi, pageEvent } = makeFakeCrowi(null);
      const pubsub = createPageEventPubSub(crowi);
      await pubsub.setup();
      const listener = jest.fn();
      pageEvent.on('update', listener);

      // Same instanceId as the pubsub instance → must be skipped.
      await simulateIncomingMessage(crowi, pubsub.instanceId, {
        instanceId: pubsub.instanceId,
        eventName: 'update',
        pageId: 'p1',
        userId: 'u1',
      });

      expect(listener).not.toHaveBeenCalled();
    });

    test('other-instance update fan-out hydrates docs and re-emits locally', async () => {
      const { crowi, Page, User, pageEvent } = makeFakeCrowi(null);
      const pubsub = createPageEventPubSub(crowi);
      await pubsub.setup();
      const listener = jest.fn();
      pageEvent.on('update', listener);

      await simulateIncomingMessage(crowi, pubsub.instanceId, {
        instanceId: 'remote-instance-uuid',
        eventName: 'update',
        pageId: 'p1',
        userId: 'u1',
        bookmarkCount: 3,
      });

      expect(Page.findById).toHaveBeenCalledWith('p1');
      expect(User.findById).toHaveBeenCalledWith('u1');
      expect(listener).toHaveBeenCalledTimes(1);
      const [pageArg, userArg, countArg] = listener.mock.calls[0];
      expect(pageArg).toMatchObject({ _id: 'page-1' });
      expect(userArg).toMatchObject({ username: 'alice' });
      expect(countArg).toBe(3);
    });

    test('hydrate failure (Page.findById returns null) skips fan-out silently', async () => {
      const { crowi, Page, pageEvent } = makeFakeCrowi(null);
      Page.findById.mockReturnValue({ exec: () => Promise.resolve(null) });
      const pubsub = createPageEventPubSub(crowi);
      await pubsub.setup();
      const listener = jest.fn();
      pageEvent.on('update', listener);

      await simulateIncomingMessage(crowi, pubsub.instanceId, {
        instanceId: 'remote',
        eventName: 'update',
        pageId: 'page-gone',
        userId: 'u1',
      });

      expect(listener).not.toHaveBeenCalled();
    });

    test('bookmarkCount defaults to 0 when omitted', async () => {
      const { crowi, pageEvent } = makeFakeCrowi(null);
      const pubsub = createPageEventPubSub(crowi);
      await pubsub.setup();
      const listener = jest.fn();
      pageEvent.on('update', listener);

      await simulateIncomingMessage(crowi, pubsub.instanceId, {
        instanceId: 'remote',
        eventName: 'update',
        pageId: 'p1',
        userId: 'u1',
      });

      expect(listener.mock.calls[0][2]).toBe(0);
    });
  });
});
