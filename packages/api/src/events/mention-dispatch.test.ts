import mongoose from 'mongoose';
import { faker } from '@faker-js/faker';
import type { NotifierDriver, NotificationPayload } from '@crowi/plugin-api';
import { crowi, Fixture } from 'src/test/setup';
import { dispatchMentions } from './mention-dispatch';

/**
 * RFC-0002 Phase 8 mention-dispatch unit tests.
 *
 * Exercises the dispatcher's diff / self-skip / inactive-skip /
 * unknown-username-skip branches and verifies that the produced
 * notification is forwarded to registered notifier drivers.
 *
 * We call `dispatchMentions` directly rather than going through the
 * EventEmitter — the event wiring is a one-liner whose only job is to
 * route `(savedPage, user)` to this function, so testing the function
 * gives us full branch coverage without async event-loop coordination.
 */
describe('events/mention-dispatch (RFC-0002 Phase 8)', () => {
  const ObjectId = mongoose.Types.ObjectId;

  let Page: ReturnType<typeof crowi.model>;
  let User: ReturnType<typeof crowi.model>;
  let Revision: ReturnType<typeof crowi.model>;
  let Notification: ReturnType<typeof crowi.model>;
  let Activity: ReturnType<typeof crowi.model>;

  beforeAll(() => {
    Page = crowi.model('Page');
    User = crowi.model('User');
    Revision = crowi.model('Revision');
    Notification = crowi.model('Notification');
    Activity = crowi.model('Activity');
  });

  // Usernames this block resolves mentions against (re-used across tests with
  // fresh _ids each time). Pages/revisions all live under PATH_PREFIX. Cleanup
  // is scoped to these markers so the wipe never touches another block's seed
  // users — a broad `User.deleteMany({})` here was a cross-block 401-flake
  // source (it wiped JWT-backed seed users created by other suites sharing the
  // test database under parallel jest workers).
  const OWNED_USERNAMES = ['author', 'alice', 'bob', 'carol', 'selfie', 'gone', 'nobody'];
  const PATH_PREFIX = '/mention-dispatch-test/';

  beforeEach(async () => {
    // Resolve this block's owned users (by the known username set) so the
    // Notification/Activity cleanup can be keyed on their ids — those rows are
    // always `{ user: <one of these> }` / `{ target: <an owned page> }`.
    const ownedUsers = await User.find({ username: { $in: OWNED_USERNAMES } }, { _id: 1 });
    const ownedUserIds = ownedUsers.map((u) => u._id);
    const ownedPages = await Page.find({ path: { $regex: `^${PATH_PREFIX}` } }, { _id: 1 });
    const ownedPageIds = ownedPages.map((p) => p._id);

    await Promise.all([
      User.deleteMany({ username: { $in: OWNED_USERNAMES } }),
      Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } }),
      Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } }),
      Notification.deleteMany({ $or: [{ user: { $in: ownedUserIds } }, { target: { $in: ownedPageIds } }] }),
      Activity.deleteMany({ $or: [{ user: { $in: ownedUserIds } }, { target: { $in: ownedPageIds } }] }),
    ]);
  });

  // Build a Page + latest Revision pair with the given mention usernames.
  // Optionally seeds a prior revision with `previousMentions` so the diff
  // path can be exercised. All paths live under PATH_PREFIX so cleanup can
  // scope to this block's owned pages/revisions.
  async function seedPage(args: {
    authorId: mongoose.Types.ObjectId;
    path?: string;
    mentions: string[];
    previousMentions?: string[];
  }): Promise<{ page: any; revisionId: mongoose.Types.ObjectId }> {
    const path = args.path ?? `${PATH_PREFIX}${faker.lorem.word()}-${Date.now()}`;
    const [page] = await Fixture.generate('Page', [{ _id: new ObjectId(), path, grant: 1 /* PUBLIC */, creator: args.authorId }]);
    if (args.previousMentions) {
      await Fixture.generate('Revision', [
        {
          _id: new ObjectId(),
          path,
          body: ' ',
          author: args.authorId,
          createdAt: new Date(Date.now() - 60_000),
          meta: { mentions: args.previousMentions.map((u) => ({ username: u })) },
        },
      ]);
    }
    const [latest] = await Fixture.generate('Revision', [
      {
        _id: new ObjectId(),
        path,
        body: ' ',
        author: args.authorId,
        createdAt: new Date(),
        meta: { mentions: args.mentions.map((u) => ({ username: u })) },
      },
    ]);
    page.revision = latest._id;
    await page.save();
    return { page, revisionId: latest._id };
  }

  it('creates a Notification for each new mentioned user (active, not self)', async () => {
    const authorId = new ObjectId();
    const aliceId = new ObjectId();
    const bobId = new ObjectId();
    await Fixture.generate('User', [
      { _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: aliceId, username: 'alice', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: bobId, username: 'bob', email: faker.internet.email(), status: User.STATUS_ACTIVE },
    ]);

    const { page } = await seedPage({ authorId, mentions: ['alice', 'bob'] });

    await dispatchMentions(crowi, page, { _id: authorId });

    const aliceNotif = await Notification.find({ user: aliceId, action: 'MENTION' });
    const bobNotif = await Notification.find({ user: bobId, action: 'MENTION' });
    expect(aliceNotif).toHaveLength(1);
    expect(bobNotif).toHaveLength(1);
    expect(String(aliceNotif[0].target)).toBe(String(page._id));
  });

  it('only notifies usernames added in the latest revision (diff against previous)', async () => {
    const authorId = new ObjectId();
    const aliceId = new ObjectId();
    const carolId = new ObjectId();
    await Fixture.generate('User', [
      { _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: aliceId, username: 'alice', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: carolId, username: 'carol', email: faker.internet.email(), status: User.STATUS_ACTIVE },
    ]);

    // Previous revision already mentioned alice; current mentions alice + carol.
    // Only carol should be notified (alice was already noticed before).
    const { page } = await seedPage({
      authorId,
      mentions: ['alice', 'carol'],
      previousMentions: ['alice'],
    });

    await dispatchMentions(crowi, page, { _id: authorId });

    const aliceNotif = await Notification.find({ user: aliceId, action: 'MENTION' });
    const carolNotif = await Notification.find({ user: carolId, action: 'MENTION' });
    expect(aliceNotif).toHaveLength(0);
    expect(carolNotif).toHaveLength(1);
  });

  it('DC-5 (feature-revision-page-ref): diffs against the previous revision of the SAME page, not an unrelated page’s revision that happens to share this path', async () => {
    const authorId = new ObjectId();
    const aliceId = new ObjectId();
    await Fixture.generate('User', [
      { _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: aliceId, username: 'alice', email: faker.internet.email(), status: User.STATUS_ACTIVE },
    ]);

    const sharedPath = `${PATH_PREFIX}reused-path`;
    const pageAId = new ObjectId(); // simulates a hard-deleted page — no live Page document.
    const pageBId = new ObjectId();

    // A stray revision from a DIFFERENT page (`page: pageAId`) that used to
    // live at `sharedPath` before it was hard-deleted and the path reused.
    // It already mentions alice — if the dispatcher still diffed by `path`
    // (pre-fix), this would wrongly suppress alice's notification below.
    await Fixture.generate('Revision', [
      {
        _id: new ObjectId(),
        path: sharedPath,
        page: pageAId,
        body: ' ',
        author: authorId,
        createdAt: new Date(Date.now() - 60_000),
        meta: { mentions: [{ username: 'alice' }] },
      },
    ]);

    const [page] = await Fixture.generate('Page', [{ _id: pageBId, path: sharedPath, grant: 1 /* PUBLIC */, creator: authorId }]);
    const [latest] = await Fixture.generate('Revision', [
      {
        _id: new ObjectId(),
        path: sharedPath,
        page: pageBId,
        body: ' ',
        author: authorId,
        createdAt: new Date(),
        meta: { mentions: [{ username: 'alice' }] },
      },
    ]);
    page.revision = latest._id;
    await page.save();

    await dispatchMentions(crowi, page, { _id: authorId });

    // Page B's own first revision mentions alice for the first time — it
    // must notify, because the SAME-page diff correctly finds no prior
    // revision for page B (the pageAId revision at the same path doesn't
    // count).
    const aliceNotif = await Notification.find({ user: aliceId, action: 'MENTION', target: pageBId });
    expect(aliceNotif).toHaveLength(1);
  });

  it('skips self-mention (author === mentioned user)', async () => {
    const authorId = new ObjectId();
    await Fixture.generate('User', [{ _id: authorId, username: 'selfie', email: faker.internet.email(), status: User.STATUS_ACTIVE }]);

    const { page } = await seedPage({ authorId, mentions: ['selfie'] });
    await dispatchMentions(crowi, page, { _id: authorId });

    const notifs = await Notification.find({ user: authorId, action: 'MENTION' });
    expect(notifs).toHaveLength(0);
  });

  it('skips inactive (suspended) users + emits debug log only', async () => {
    const authorId = new ObjectId();
    const suspendedId = new ObjectId();
    await Fixture.generate('User', [
      { _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: suspendedId, username: 'gone', email: faker.internet.email(), status: User.STATUS_SUSPENDED },
    ]);

    const { page } = await seedPage({ authorId, mentions: ['gone'] });
    await dispatchMentions(crowi, page, { _id: authorId });

    const notifs = await Notification.find({ user: suspendedId });
    expect(notifs).toHaveLength(0);
  });

  it('skips unknown usernames and logs a warning (silent drop)', async () => {
    const authorId = new ObjectId();
    await Fixture.generate('User', [{ _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE }]);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { page } = await seedPage({ authorId, mentions: ['nobody'] });
      await dispatchMentions(crowi, page, { _id: authorId });

      const notifs = await Notification.find({ action: 'MENTION' });
      expect(notifs).toHaveLength(0);
      const warnedAboutNobody = warnSpy.mock.calls.some((call) => String(call[0]).includes("'@nobody'"));
      expect(warnedAboutNobody).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('forwards the upserted notification to every active notifier plugin (fire-and-forget)', async () => {
    const authorId = new ObjectId();
    const aliceId = new ObjectId();
    await Fixture.generate('User', [
      { _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE },
      { _id: aliceId, username: 'alice', email: faker.internet.email(), status: User.STATUS_ACTIVE },
    ]);

    const sent: NotificationPayload[] = [];
    const fixtureDriver: NotifierDriver = {
      async send(p) {
        sent.push(p);
      },
    };

    // Patch the active.notifiers list directly. We don't go through
    // PluginManager.activate here because that would require a fully-
    // loaded plugin package; the registry shape is the only contract
    // upsertByActivity depends on.
    const original = crowi.pluginRegistries;
    const patched = {
      ...(original ?? ({} as never)),
      active: {
        ...(original?.active ?? {}),
        notifiers: [fixtureDriver],
      },
    };
    crowi.pluginRegistries = patched as never;

    try {
      const { page } = await seedPage({ authorId, mentions: ['alice'] });
      await dispatchMentions(crowi, page, { _id: authorId });
      // Forwarder is fire-and-forget — flush the microtask queue once.
      await new Promise((r) => setImmediate(r));

      expect(sent).toHaveLength(1);
      expect(sent[0].event).toBe('notification:MENTION');
      expect(sent[0].title).toContain('MENTION');
    } finally {
      crowi.pluginRegistries = original;
    }
  });

  it('tolerates listener failures (fire-and-forget, save unaffected)', async () => {
    const authorId = new ObjectId();
    await Fixture.generate('User', [{ _id: authorId, username: 'author', email: faker.internet.email(), status: User.STATUS_ACTIVE }]);

    // Page with revision pointer that doesn't exist → dispatchMentions returns early.
    const [page] = await Fixture.generate('Page', [
      { _id: new ObjectId(), path: `${PATH_PREFIX}missing-rev`, grant: 1, creator: authorId, revision: new ObjectId() },
    ]);

    await expect(dispatchMentions(crowi, page, { _id: authorId })).resolves.toBeUndefined();
  });
});
