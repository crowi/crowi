import { crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { Fixture } from 'src/test/setup';

import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationRunner } from '../runner';
import { rewriteWikilinks } from './wikilink-format';
import { detectRecoverable, rewriteBody, shouldRecoverSegment, wikilinkHtmlRecover } from './wikilink-html-recover';

/**
 * `wikilink-html-recover` preflight migration.
 *
 * Two halves:
 *   1. The pure recovery logic: `shouldRecoverSegment` / `detectRecoverable` /
 *      `rewriteBody` — the inverse gate of `wikilink-format`'s rewrite for the
 *      single-segment HTML-element case.
 *   2. The framework wiring: `isPending` / `detect` / `apply`, idempotency,
 *      and the same-named-page collision skip.
 */

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/wikilink-html-recover — recovery rules (pure)', () => {
  describe('shouldRecoverSegment', () => {
    it.each([
      ['font'],
      ['center'],
      ['marquee'],
      ['blink'],
      ['applet'],
      ['div'],
      ['section'],
      ['br'],
      ['h1'],
      ['span'],
    ])('recovers HTML element %s', (segment) => {
      expect(shouldRecoverSegment(segment)).toBe(true);
    });

    it.each([['foo'], ['wiki'], ['docs'], ['home'], ['page']])('does NOT recover non-HTML name %s', (segment) => {
      expect(shouldRecoverSegment(segment)).toBe(false);
    });

    it('does NOT recover uppercase (case-sensitive page) names', () => {
      expect(shouldRecoverSegment('Font')).toBe(false);
      expect(shouldRecoverSegment('Section')).toBe(false);
    });
  });

  describe('detectRecoverable', () => {
    it('finds single-segment HTML-element occurrences', () => {
      expect(detectRecoverable('a [[/font]] b [[/center]] c')).toEqual([
        { raw: '[[/font]]', element: 'font' },
        { raw: '[[/center]]', element: 'center' },
      ]);
    });

    it('ignores multi-segment wikilinks', () => {
      expect(detectRecoverable('[[/foo/bar]] [[/font/sub]]')).toEqual([]);
    });

    it('ignores aliased wikilinks', () => {
      expect(detectRecoverable('[[/font|My Font Page]]')).toEqual([]);
    });

    it('ignores non-HTML and uppercase names', () => {
      expect(detectRecoverable('[[/wiki]] [[/Font]] [[/Section]]')).toEqual([]);
    });
  });

  describe('rewriteBody', () => {
    it('reverts [[/font]] to </font>', () => {
      expect(rewriteBody('see [[/font]] here', new Set())).toBe('see </font> here');
    });

    it('reverts multiple deprecated tags', () => {
      expect(rewriteBody('[[/font]][[/center]][[/marquee]][[/blink]][[/applet]]', new Set())).toBe('</font></center></marquee></blink></applet>');
    });

    it('preserves genuine wikilinks', () => {
      const body = '[[/foo/bar]] and [[/font|alias]] and [[/Section]] and [[/wiki-page]]';
      expect(rewriteBody(body, new Set())).toBe(body);
    });

    it('returns the input by reference when nothing changes', () => {
      const body = 'no recoverable markup [[/foo/bar]]';
      expect(rewriteBody(body, new Set())).toBe(body);
    });

    it('skips elements named in the collision set', () => {
      expect(rewriteBody('[[/font]] and [[/center]]', new Set(['font']))).toBe('[[/font]] and </center>');
    });

    it('is idempotent — reverted </font> is not re-detected', () => {
      const once = rewriteBody('see [[/font]] here', new Set());
      expect(detectRecoverable(once)).toEqual([]);
      expect(rewriteBody(once, new Set())).toBe(once);
    });
  });

  describe('round-trips with wikilink-format', () => {
    it('reverting then re-running wikilink-format leaves the close tag alone (no double misfire)', () => {
      // The 5 deprecated tags are now in KNOWN_HTML_ELEMENTS, so a re-run of
      // the forward rewrite leaves </font> as-is — the corruption cannot recur.
      const recovered = rewriteBody('### [[/font]]Title[[/font]]', new Set());
      expect(recovered).toBe('### </font>Title</font>');
      expect(rewriteWikilinks(recovered)).toBe(recovered);
    });
  });
});

describe('migration/wikilink-html-recover — framework wiring', () => {
  let Page;
  let Revision;
  let admin: UserDocument;

  const PATH_PREFIX = '/__wikilink-recover';

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const [user] = (await Fixture.generate('User', [
      { name: 'Recover Admin', username: 'recover-admin', email: 'recover-admin@example.com', admin: true },
    ])) as UserDocument[];
    admin = user;
  });

  beforeEach(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Page.deleteMany({ path: '/font' });
    await Revision.deleteMany({ path: '/font' });
    await MigrationApplication().deleteMany({ migrationId: 'wikilink-html-recover' });
  });

  afterAll(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Page.deleteMany({ path: '/font' });
    await Revision.deleteMany({ path: '/font' });
    await crowi.model('User').deleteOne({ _id: admin._id });
  });

  it('registry exposes wikilink-html-recover as a preflight migration ordered after wikilink-format', () => {
    expect(wikilinkHtmlRecover.id).toBe('wikilink-html-recover');
    expect(wikilinkHtmlRecover.layer).toBe('preflight');
    expect((wikilinkHtmlRecover.order ?? 0) > 0).toBe(true);
  });

  it('isPending detects a corrupted [[/font]], clears after apply', async () => {
    await Page.createPage(`${PATH_PREFIX}/a`, 'see [[/font]] here', admin, {});

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkHtmlRecover)).toBe(true);

    await runner.apply(wikilinkHtmlRecover);
    expect(await runner.isPending(wikilinkHtmlRecover)).toBe(false);
  });

  it('isPending is false when only genuine wikilinks are present', async () => {
    await Page.createPage(`${PATH_PREFIX}/b`, '[[/foo/bar]] and [[/font|alias]]', admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkHtmlRecover)).toBe(false);
  });

  it('reverts the body via the updatePage path and records the application', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/c`, '### [[/font]]Workspace[[/font]]', admin, {});
    const pageId = created._id;

    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(wikilinkHtmlRecover);
    expect(outcome.result).toBe('applied');
    expect((outcome.stats['recover-html-close-tags'] as { transformed: number }).transformed).toBe(1);

    const page = await Page.findById(pageId).populate('revision');
    expect(page.revision.body).toBe('### </font>Workspace</font>');

    const recorded = await MigrationApplication().latestFor('wikilink-html-recover');
    expect(recorded?.result).toBe('applied');
    expect(recorded?.layer).toBe('preflight');
  });

  it('nulls yjsState / yjsCheckpointAt on the reverted page (Yjs invalidation)', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/yjs`, 'has [[/font]] tag', admin, {});
    const pageId = created._id;
    await Page.updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from([1, 2, 3]), yjsCheckpointAt: new Date() } });

    await new MigrationRunner(crowi).apply(wikilinkHtmlRecover);

    const after = await Page.findById(pageId).select('yjsState yjsCheckpointAt');
    expect(after.yjsState).toBeNull();
    expect(after.yjsCheckpointAt).toBeNull();
  });

  it('skips an occurrence that collides with a same-named real page and reports it in detect', async () => {
    // A real page literally at /font exists, so [[/font]] is ambiguous and
    // must NOT be auto-reverted; it is reported for manual review instead.
    await Page.createPage('/font', 'this is a genuine page about fonts', admin, {});
    const corrupted = await Page.createPage(`${PATH_PREFIX}/coll`, 'link to [[/font]] page', admin, {});

    const runner = new MigrationRunner(crowi);

    const report = await runner.detect(wikilinkHtmlRecover);
    expect(report?.counts?.pages).toBe(0);
    expect(report?.counts?.occurrences).toBe(0);
    expect(report?.counts?.collisions).toBe(1);
    expect(report?.summary).toContain('/font');

    // Not pending (the only occurrence collides → never reverted).
    expect(await runner.isPending(wikilinkHtmlRecover)).toBe(false);

    await runner.apply(wikilinkHtmlRecover);
    const page = await Page.findById(corrupted._id).populate('revision');
    // Left untouched.
    expect(page.revision.body).toBe('link to [[/font]] page');
  });

  it('detect reports affected page + occurrence counts', async () => {
    await Page.createPage(`${PATH_PREFIX}/d1`, 'a [[/font]] b [[/center]]', admin, {});
    await Page.createPage(`${PATH_PREFIX}/d2`, 'just [[/foo/bar]]', admin, {});

    const runner = new MigrationRunner(crowi);
    const report = await runner.detect(wikilinkHtmlRecover);
    expect(report?.counts?.pages).toBe(1);
    expect(report?.counts?.occurrences).toBe(2);
    expect(report?.counts?.collisions).toBe(0);
  });

  it('apply is idempotent — a second run is a no-op (not pending)', async () => {
    await Page.createPage(`${PATH_PREFIX}/idem`, 'has [[/marquee]] tag', admin, {});
    const runner = new MigrationRunner(crowi);

    await runner.apply(wikilinkHtmlRecover);
    expect(await runner.isPending(wikilinkHtmlRecover)).toBe(false);

    const second = await runner.apply(wikilinkHtmlRecover);
    // Second apply: not pending + already applied → consistent no-op.
    expect(second.stats['recover-html-close-tags']).toBeUndefined();
  });

  it('dry-run reverts nothing and records nothing', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/dry`, 'see [[/font]] here', admin, {});
    const pageId = created._id;

    const runner = new MigrationRunner(crowi, { dryRun: true });
    await runner.apply(wikilinkHtmlRecover);

    const page = await Page.findById(pageId).populate('revision');
    expect(page.revision.body).toBe('see [[/font]] here');
    expect(await MigrationApplication().countDocuments({ migrationId: 'wikilink-html-recover' })).toBe(0);
  });
});
