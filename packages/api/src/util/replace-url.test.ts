import { STATUS_DELETED } from 'src/models/page';
import type { RevisionDocument } from 'src/models/revision';
import type { UserDocument } from 'src/models/user';
import { crowi, Fixture } from 'src/test/setup';

import { assessReplaceSafety, replaceUrlInBody, runReplaceUrl } from './replace-url';

/**
 * feature-url-replace-admin-cli — bulk in-body URL replacement.
 *
 * Two halves:
 *   1. The pure logic — `replaceUrlInBody` (literal global replace) and
 *      `assessReplaceSafety` (the prefix-collision / footgun guard).
 *   2. The persistence behaviour of `runReplaceUrl` — the load-bearing claim
 *      that a rewrite pushes a new revision and nulls the Yjs snapshot WITHOUT
 *      bumping `updatedAt` / `lastUpdateUser` / `grant` and WITHOUT emitting
 *      `pageEvent` (so watchers are not notified and the acting user is not
 *      auto-watched onto every page).
 */

describe('util/replace-url — replaceUrlInBody (pure)', () => {
  it('returns the input unchanged (by reference) when there is no match', () => {
    const body = 'no old host here';
    const result = replaceUrlInBody(body, 'https://old.example', 'https://new.example');
    expect(result.body).toBe(body);
    expect(result.occurrences).toBe(0);
  });

  it('replaces every literal occurrence and counts them', () => {
    const body = 'a https://old.example/x b https://old.example/y';
    const result = replaceUrlInBody(body, 'https://old.example', 'https://new.example');
    expect(result.body).toBe('a https://new.example/x b https://new.example/y');
    expect(result.occurrences).toBe(2);
  });

  it('handles regex-special characters in from/to literally', () => {
    const body = 'see ![s](https://old.example/files/abc.123?x=1)';
    const result = replaceUrlInBody(body, 'https://old.example', 'https://new.example');
    expect(result.body).toBe('see ![s](https://new.example/files/abc.123?x=1)');
    expect(result.occurrences).toBe(1);
  });

  it('is a no-op when from === to or from is empty', () => {
    expect(replaceUrlInBody('x', 'a', 'a')).toEqual({ body: 'x', occurrences: 0 });
    expect(replaceUrlInBody('x', '', 'a')).toEqual({ body: 'x', occurrences: 0 });
  });

  it('replaces in a single left-to-right pass (no re-scan of inserted text)', () => {
    // `to` contains `from`; a single pass must not loop on the inserted copy.
    const result = replaceUrlInBody('ab', 'a', 'aa');
    expect(result.body).toBe('aab');
    expect(result.occurrences).toBe(1);
  });
});

describe('util/replace-url — assessReplaceSafety (pure)', () => {
  it('errors on empty / identical / too-short from', () => {
    expect(assessReplaceSafety('', 'x').errors).toContain('--from must not be empty.');
    expect(assessReplaceSafety('https://x', 'https://x').errors[0]).toMatch(/identical/);
    expect(assessReplaceSafety('ab', 'cd').errors[0]).toMatch(/too short/);
  });

  it('flags a scheme-less bare host (prefix-collision risk → needs --force)', () => {
    expect(assessReplaceSafety('wiki.example.in', 'wiki.example.net').bareHostFrom).toBe(true);
    expect(assessReplaceSafety('https://wiki.example.in', 'https://wiki.example.net').bareHostFrom).toBe(false);
  });

  it('warns when to contains from (non-idempotent) or args look swapped', () => {
    expect(assessReplaceSafety('https://x.io', 'https://x.io/v2').warnings[0]).toMatch(/re-running/);
    expect(assessReplaceSafety('https://x.io/v2', 'https://x.io').warnings[0]).toMatch(/swap/);
  });
});

describe('util/replace-url — runReplaceUrl (persistence)', () => {
  let Page: ReturnType<typeof crowi.model<'Page'>>;
  let Revision: ReturnType<typeof crowi.model<'Revision'>>;
  let creator: UserDocument;
  let operator: UserDocument;

  const PATH_PREFIX = '/__replace-url';
  const FROM = 'https://old.example';
  const TO = 'https://new.example';

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const users = (await Fixture.generate('User', [
      { name: 'Replace Creator', username: 'replace-creator', email: 'replace-creator@example.com', admin: true },
      { name: 'Replace Operator', username: 'replace-operator', email: 'replace-operator@example.com', admin: true },
    ])) as UserDocument[];
    creator = users[0];
    operator = users[1];
  });

  beforeEach(async () => {
    const pages = await Page.find({ path: { $regex: `^${PATH_PREFIX}` } })
      .select('_id revision')
      .lean();
    await Revision.deleteMany({ _id: { $in: pages.map((p) => p.revision).filter(Boolean) } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
  });

  afterAll(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await crowi.model('User').deleteMany({ _id: { $in: [creator._id, operator._id] } });
  });

  it('rewrites the body via a NEW revision, keeping the old one revertable', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/a`, `see ![s](${FROM}/files/id1) and ${FROM}/p`, creator, {});
    // Re-read from the DB: createPage's return value carries the revision as a
    // populated document, so read the raw ObjectId ref instead.
    const before = await Page.findById(created._id).select('revision').lean();
    const origRevId = String(before?.revision);

    const summary = await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email });
    expect(summary.pagesRewritten).toBe(1);
    expect(summary.occurrences).toBe(2);
    expect(summary.failed).toBe(0);

    const page = await Page.findById(created._id).select('revision').lean();
    expect(String(page?.revision)).not.toBe(origRevId); // new revision pointer
    const newRev = await Revision.findById(page?.revision).exec();
    expect(newRev?.body).toBe(`see ![s](${TO}/files/id1) and ${TO}/p`);
    // Old revision is immutable and still holds the pre-replace body.
    const oldRev = await Revision.findById(origRevId).exec();
    expect(oldRev?.body).toContain(FROM);
  });

  it('records the acting user as the new revision author but leaves page.lastUpdateUser untouched', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/author`, `x ${FROM}/y`, creator, {});
    const before = await Page.findById(created._id).select('lastUpdateUser').lean();
    expect(String(before?.lastUpdateUser)).toBe(String(creator._id));

    await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email });

    const page = await Page.findById(created._id).select('lastUpdateUser revision').lean();
    expect(String(page?.lastUpdateUser)).toBe(String(creator._id)); // unchanged
    const rev = (await Revision.findById(page?.revision).exec()) as RevisionDocument;
    expect(String(rev.author)).toBe(String(operator._id)); // audit trail
  });

  // Phase 2a, AC-5 — the allocator is called explicitly from `quietRewrite`
  // (the only content writer that reaches neither `pushRevision` nor
  // `updatePage`).
  it('assigns the next content sequence to the rewritten revision without touching updatedAt / lastUpdateUser (AC-5)', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/history-sequence`, `x ${FROM}/y`, creator, {});
    const pinnedDate = new Date('2020-01-01T00:00:00.000Z');
    await Page.updateOne({ _id: created._id }, { $set: { updatedAt: pinnedDate } });
    const before = await Page.findById(created._id).select('historySequence lastUpdateUser').lean();
    expect(before?.historySequence).toBe(1); // seeded by createPage's own allocator promotion

    await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email });

    const page = await Page.findById(created._id).select('revision historySequence updatedAt lastUpdateUser').lean();
    expect(page?.historySequence).toBe(2);
    expect(page?.updatedAt.getTime()).toBe(pinnedDate.getTime());
    expect(String(page?.lastUpdateUser)).toBe(String(before?.lastUpdateUser));

    const newRev = await Revision.findById(page?.revision).lean();
    expect(newRev?.historySequence).toBe(2);
  });

  it('does not bump updatedAt or change grant / grantedUsers', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/quiet`, `x ${FROM}/y`, creator, {});
    const pinnedDate = new Date('2020-01-01T00:00:00.000Z');
    await Page.updateOne({ _id: created._id }, { $set: { updatedAt: pinnedDate } });
    const before = await Page.findById(created._id).select('grant grantedUsers').lean();

    await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email });

    const page = await Page.findById(created._id).select('updatedAt grant grantedUsers').lean();
    expect(page?.updatedAt.getTime()).toBe(pinnedDate.getTime()); // listing order frozen
    expect(page?.grant).toBe(1); // GRANT_PUBLIC — NOT nulled (unlike updatePage)
    // grant + grantedUsers are left exactly as they were (createPage seeds
    // grantedUsers itself; the point is the rewrite must not touch them).
    expect(page?.grant).toBe(before?.grant);
    expect((page?.grantedUsers ?? []).map(String)).toEqual((before?.grantedUsers ?? []).map(String));
  });

  it('nulls yjsState / yjsCheckpointAt so collab rebuilds from the new body', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/yjs`, `x ${FROM}/y`, creator, {});
    await Page.updateOne({ _id: created._id }, { $set: { yjsState: Buffer.from([1, 2, 3]), yjsCheckpointAt: new Date() } });

    await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email });

    const page = await Page.findById(created._id).select('yjsState yjsCheckpointAt').exec();
    expect(page?.yjsState).toBeNull();
    expect(page?.yjsCheckpointAt).toBeNull();
  });

  it('does NOT emit pageEvent("update") (no watcher notification / auto-watch)', async () => {
    await Page.createPage(`${PATH_PREFIX}/silent`, `x ${FROM}/y`, creator, {});
    const pageEvent = crowi.event('Page');
    const emitSpy = jest.spyOn(pageEvent, 'emit');
    try {
      await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email });
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      emitSpy.mockRestore();
    }
  });

  it('dry-run reports matches without writing anything', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/dry`, `a ${FROM}/x b ${FROM}/y`, creator, {});
    const before = await Page.findById(created._id).select('revision').lean();
    const origRevId = String(before?.revision);

    const summary = await runReplaceUrl(crowi, { from: FROM, to: TO, dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.pagesMatched).toBe(1);
    expect(summary.occurrences).toBe(2);
    expect(summary.pagesRewritten).toBe(0);
    expect(summary.samples[0].path).toBe(`${PATH_PREFIX}/dry`);

    const page = await Page.findById(created._id).select('revision').lean();
    expect(String(page?.revision)).toBe(origRevId); // untouched
  });

  it('excludes trashed pages by default and includes them with includeTrash', async () => {
    await Page.createPage(`${PATH_PREFIX}/live`, `x ${FROM}/y`, creator, {});
    const trashed = await Page.createPage(`${PATH_PREFIX}/trashed`, `x ${FROM}/z`, creator, {});
    await Page.updateOne({ _id: trashed._id }, { $set: { status: STATUS_DELETED } });

    const def = await runReplaceUrl(crowi, { from: FROM, to: TO, dryRun: true });
    expect(def.pagesMatched).toBe(1);

    const withTrash = await runReplaceUrl(crowi, { from: FROM, to: TO, dryRun: true, includeTrash: true });
    expect(withTrash.pagesMatched).toBe(2);
  });

  it('aborts without writing when the confirm hook declines', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/declined`, `x ${FROM}/y`, creator, {});
    const before = await Page.findById(created._id).select('revision').lean();
    const origRevId = String(before?.revision);

    const summary = await runReplaceUrl(crowi, { from: FROM, to: TO, userEmail: operator.email, confirm: async () => false });
    expect(summary.aborted).toBe(true);
    expect(summary.pagesRewritten).toBe(0);

    const page = await Page.findById(created._id).select('revision').lean();
    expect(String(page?.revision)).toBe(origRevId);
  });
});
