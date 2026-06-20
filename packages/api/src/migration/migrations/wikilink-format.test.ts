import { crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { Fixture } from 'src/test/setup';

import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationRunner } from '../runner';
import { KNOWN_HTML_ELEMENTS, bodyHasRewritableWikilink, rewriteAndDetect, rewriteWikilinks, shouldRewriteWikilink, wikilinkFormat } from './wikilink-format';

/**
 * RFC-0008 §10.2 step 4 / §4.3.1 — `wikilink-format` preflight migration.
 *
 * Two halves:
 *   1. The pure textual conversion logic, ported from the deleted
 *      `admin-cli/.../migrate-wikilink.test.ts` — the rewrite output must stay
 *      byte-identical to the legacy migrator.
 *   2. The framework wiring: `isPending` / `detect`, and the regression test
 *      that the body rewrite routes through the `updatePage`-equivalent path so
 *      `yjsState` / `yjsCheckpointAt` are nulled (the motivating bug — the old
 *      command pushed a revision directly and left the Yjs snapshot stale).
 */

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/wikilink-format — detection rules (pure)', () => {
  describe('shouldRewriteWikilink — positive matches', () => {
    it.each([['/foo'], ['/foo/bar'], ['/foo/bar/baz'], ['/docs/api'], ['/setup-guide']])('accepts %s', (innerPath) => {
      expect(shouldRewriteWikilink(innerPath)).toBe(true);
    });

    it('accepts paths with anchor segments', () => {
      expect(shouldRewriteWikilink('/docs/api#auth')).toBe(true);
    });

    it('accepts deep paths even when an intermediate segment is HTML-like', () => {
      // HTML element rejection is ONLY against the first segment.
      expect(shouldRewriteWikilink('/docs/section')).toBe(true);
      expect(shouldRewriteWikilink('/foo/div')).toBe(true);
    });

    it('accepts paths whose first segment LOOKS like HTML but contains an uppercase letter', () => {
      // Crowi pages are case-sensitive: `Section` !== the HTML `section`.
      expect(shouldRewriteWikilink('/Section')).toBe(true);
      expect(shouldRewriteWikilink('/Div/things')).toBe(true);
    });
  });

  describe('shouldRewriteWikilink — negative matches (HTML elements)', () => {
    it.each([
      ['/section'],
      ['/div'],
      ['/a'],
      ['/br'],
      ['/iframe'],
      ['/article'],
      ['/p'],
      ['/span'],
      ['/h1'],
      ['/h6'],
      ['/script'],
      ['/style'],
    ])('rejects %s (HTML element)', (innerPath) => {
      expect(shouldRewriteWikilink(innerPath)).toBe(false);
    });

    it('rejects HTML elements with trailing slashes or anchors', () => {
      expect(shouldRewriteWikilink('/section/foo')).toBe(false);
      expect(shouldRewriteWikilink('/div#anchor')).toBe(false);
    });

    it('rejects `/` alone (stray markup)', () => {
      expect(shouldRewriteWikilink('/')).toBe(false);
    });

    it('rejects inputs that do not start with `/`', () => {
      expect(shouldRewriteWikilink('foo')).toBe(false);
      expect(shouldRewriteWikilink('foo/bar')).toBe(false);
    });
  });

  describe('KNOWN_HTML_ELEMENTS coverage', () => {
    it('covers all common void elements', () => {
      for (const el of ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']) {
        expect(KNOWN_HTML_ELEMENTS.has(el)).toBe(true);
      }
    });

    it('covers heading tags h1 through h6', () => {
      for (const level of [1, 2, 3, 4, 5, 6]) {
        expect(KNOWN_HTML_ELEMENTS.has(`h${level}`)).toBe(true);
      }
    });

    it('does NOT include random non-HTML identifiers', () => {
      for (const word of ['docs', 'foo', 'bar', 'page', 'wiki', 'home']) {
        expect(KNOWN_HTML_ELEMENTS.has(word)).toBe(false);
      }
    });

    it('covers the deprecated presentational elements still found in legacy content', () => {
      // Regression for the close-tag misfire: `</font>` etc. were rewritten to
      // `[[/font]]` because these obsolete tags were missing from the set.
      for (const el of ['font', 'center', 'marquee', 'blink', 'applet']) {
        expect(KNOWN_HTML_ELEMENTS.has(el)).toBe(true);
      }
    });
  });

  describe('deprecated close tags are NOT rewritten (close-tag misfire regression)', () => {
    it.each([['font'], ['center'], ['marquee'], ['blink'], ['applet']])('rejects </%s> (HTML close tag)', (el) => {
      expect(shouldRewriteWikilink(`/${el}`)).toBe(false);
    });

    it('leaves a `### <font ...>Title</font>` heading body untouched', () => {
      const body = '### <font color="1a73e8">Workspace の作成</font>';
      expect(rewriteWikilinks(body)).toBe(body);
      expect(bodyHasRewritableWikilink(body)).toBe(false);
    });

    it('does not rewrite a body whose only `</` tokens are deprecated close tags', () => {
      const body = '</font></center></marquee></blink></applet>';
      expect(rewriteWikilinks(body)).toBe(body);
      expect(bodyHasRewritableWikilink(body)).toBe(false);
    });

    it('open tags were always safe (regex requires a leading `/`)', () => {
      const body = '<font color="red">x</font> <center>y</center>';
      expect(rewriteWikilinks(body)).toBe(body);
    });
  });
});

describe('migration/wikilink-format — rewriteAndDetect / rewriteWikilinks (pure)', () => {
  it('returns the input unchanged (by reference) when there are no occurrences', () => {
    const body = 'no v1 angle-bracket links here';
    const result = rewriteAndDetect(body);
    expect(result.body).toBe(body);
    expect(result.occurrences).toEqual([]);
  });

  it('rewrites `</path>` to `[[/path]]`', () => {
    expect(rewriteWikilinks('see </docs/api> for details')).toBe('see [[/docs/api]] for details');
  });

  it('rewrites multiple occurrences in one body', () => {
    const body = 'first </docs/api>, then </guide/intro>, and </faq>';
    expect(rewriteWikilinks(body)).toBe('first [[/docs/api]], then [[/guide/intro]], and [[/faq]]');
  });

  it('preserves anchor segments', () => {
    expect(rewriteWikilinks('jump </docs/api#auth>')).toBe('jump [[/docs/api#auth]]');
  });

  it('preserves alias segments', () => {
    const result = rewriteAndDetect('refer </docs/api|API Reference>');
    expect(result.body).toBe('refer [[/docs/api|API Reference]]');
    expect(result.occurrences).toEqual([{ raw: '</docs/api|API Reference>', path: '/docs/api', alias: 'API Reference' }]);
  });

  it('leaves HTML close tags alone', () => {
    const body = '<section>foo</section> and <div>bar</div>';
    expect(rewriteWikilinks(body)).toBe(body);
  });

  it('rewrites wikilinks while leaving adjacent HTML close tags untouched', () => {
    expect(rewriteWikilinks('<section>see </docs/api> here</section>')).toBe('<section>see [[/docs/api]] here</section>');
  });

  it('is idempotent', () => {
    const once = rewriteWikilinks('see </docs/api> for details');
    expect(rewriteWikilinks(once)).toBe(once);
  });

  it('handles adjacent wikilinks without a space', () => {
    expect(rewriteWikilinks('</a-real-page></another-page>')).toBe('[[/a-real-page]][[/another-page]]');
  });

  it('does NOT rewrite when only HTML close tags appear', () => {
    expect(rewriteWikilinks('</div></section></br></iframe>')).toBe('</div></section></br></iframe>');
  });
});

describe('migration/wikilink-format — bodyHasRewritableWikilink (pure verdict)', () => {
  it('is false when there is no `</` at all', () => {
    expect(bodyHasRewritableWikilink('only [[/already/v2]] here')).toBe(false);
    expect(bodyHasRewritableWikilink('plain text with no markup')).toBe(false);
  });

  it('is false when every `</` is an HTML close tag (boot-deadlock regression)', () => {
    expect(bodyHasRewritableWikilink('<div>x</div> and <span>y</span>')).toBe(false);
    expect(bodyHasRewritableWikilink('</div></section></br></iframe>')).toBe(false);
  });

  it('is true when a genuine legacy wikilink is present', () => {
    expect(bodyHasRewritableWikilink('see </docs/api> here')).toBe(true);
  });

  it('is true when a genuine wikilink sits alongside HTML close tags', () => {
    expect(bodyHasRewritableWikilink('see </docs/api> <div>x</div>')).toBe(true);
  });
});

describe('migration/wikilink-format — framework wiring', () => {
  let Page;
  let Revision;
  let admin: UserDocument;

  const PATH_PREFIX = '/__wikilink-migration';

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const [user] = (await Fixture.generate('User', [
      { name: 'Wikilink Admin', username: 'wikilink-admin', email: 'wikilink-admin@example.com', admin: true },
    ])) as UserDocument[];
    admin = user;
  });

  beforeEach(async () => {
    const pages = await Page.find({ path: { $regex: `^${PATH_PREFIX}` } })
      .select('_id revision')
      .lean();
    const revisionIds = pages.map((p) => p.revision).filter(Boolean);
    await Revision.deleteMany({ _id: { $in: revisionIds } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await MigrationApplication().deleteMany({ migrationId: 'wikilink-format' });
  });

  afterAll(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await crowi.model('User').deleteOne({ _id: admin._id });
  });

  it('registry exposes wikilink-format as a preflight migration with the right range', () => {
    expect(wikilinkFormat.id).toBe('wikilink-format');
    expect(wikilinkFormat.layer).toBe('preflight');
    expect(wikilinkFormat.fromVersion).toBe('1.x');
    expect(wikilinkFormat.toVersion).toBe('2.1');
  });

  it('isPending detects a page that still contains legacy `</path>` syntax, clean once rewritten', async () => {
    await Page.createPage(`${PATH_PREFIX}/legacy`, 'see </docs/api> here', admin, {});

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkFormat)).toBe(true);

    await runner.apply(wikilinkFormat);
    expect(await runner.isPending(wikilinkFormat)).toBe(false);
  });

  it('isPending is false when no `</` substring exists at all (pure v2 wikilinks)', async () => {
    await Page.createPage(`${PATH_PREFIX}/v2only`, 'only [[/already/v2]] here, no angle close', admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkFormat)).toBe(false);
  });

  it('isPending is false for a page whose heading uses deprecated inline HTML (`</font>` is not a wikilink)', async () => {
    // The close-tag misfire regression at the framework layer: a heading with
    // `<font …></font>` must not pend (and `migrate apply` must not rewrite it).
    await Page.createPage(`${PATH_PREFIX}/font`, '### <font color="1a73e8">Workspace</font>', admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkFormat)).toBe(false);
    const report = await runner.detect(wikilinkFormat);
    expect(report?.counts?.pages).toBe(0);
  });

  it('isPending is false for a page containing only HTML close tags (`</div>` is not a wikilink)', async () => {
    // Regression for the boot deadlock: a page with `</div>` shares the `</`
    // prefix but is NOT a genuine wikilink. The verdict applies the full
    // `shouldRewriteWikilink` rule (not the bare substring), so it reports
    // false — otherwise `</div>` would block boot forever, since `migrate
    // apply` rewrites only genuine wikilinks and would never clear it.
    await Page.createPage(`${PATH_PREFIX}/htmlonly`, '<div>x</div> and <span>y</span>', admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkFormat)).toBe(false);
    // detect agrees: no rewritable occurrence …
    const report = await runner.detect(wikilinkFormat);
    expect(report?.counts?.pages).toBe(0);
    // … and applying is a no-op: not pending → the stage never runs, so it is
    // recorded as a clean detection rather than an `applied` rewrite.
    const outcome = await runner.apply(wikilinkFormat);
    expect(outcome.result).toBe('detected-clean');
    expect(outcome.stats['rewrite-wikilink']).toBeUndefined();
  });

  it('isPending clears after apply even when the rewritten page also contains HTML close tags (no boot deadlock)', async () => {
    // A page with BOTH a genuine wikilink and an HTML close tag. Before apply
    // isPending is true (genuine wikilink); after apply only `</div>` remains,
    // which must NOT keep boot blocked.
    await Page.createPage(`${PATH_PREFIX}/mixed`, 'see </docs/api> <div>x</div>', admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(wikilinkFormat)).toBe(true);

    await runner.apply(wikilinkFormat);

    // The genuine wikilink is gone; the surviving `</div>` no longer pends.
    expect(await runner.isPending(wikilinkFormat)).toBe(false);
  });

  it('detect reports the affected page + occurrence counts', async () => {
    await Page.createPage(`${PATH_PREFIX}/d1`, 'a </docs/api> b </guide/intro>', admin, {});
    await Page.createPage(`${PATH_PREFIX}/d2`, 'just <div>html</div>', admin, {});

    const runner = new MigrationRunner(crowi);
    const report = await runner.detect(wikilinkFormat);
    expect(report?.counts?.pages).toBe(1);
    expect(report?.counts?.occurrences).toBe(2);
  });

  it('rewrites the body via the updatePage path and records the application', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/rewrite`, 'see </docs/api> for the API', admin, {});
    const pageId = created._id;

    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(wikilinkFormat);
    expect(outcome.result).toBe('applied');
    expect((outcome.stats['rewrite-wikilink'] as { transformed: number }).transformed).toBe(1);

    const page = await Page.findById(pageId).populate('revision');
    expect(page.revision.body).toBe('see [[/docs/api]] for the API');

    const recorded = await MigrationApplication().latestFor('wikilink-format');
    expect(recorded?.result).toBe('applied');
    expect(recorded?.layer).toBe('preflight');
  });

  it('nulls yjsState / yjsCheckpointAt on the rewritten page (Yjs invalidation bug fix)', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/yjs`, 'link </docs/api> here', admin, {});
    const pageId = created._id;

    // Simulate an active collab session: a persisted Y.Doc snapshot exists.
    await Page.updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from([1, 2, 3]), yjsCheckpointAt: new Date() } });

    const before = await Page.findById(pageId).select('yjsState yjsCheckpointAt');
    expect(before.yjsState).not.toBeNull();
    expect(before.yjsCheckpointAt).not.toBeNull();

    await new MigrationRunner(crowi).apply(wikilinkFormat);

    // The fix: routing through rewritePageBody → updatePage nulls the snapshot
    // so the next onLoadDocument rebuilds from the new body instead of
    // restoring the stale pre-edit Y.Doc.
    const after = await Page.findById(pageId).select('yjsState yjsCheckpointAt');
    expect(after.yjsState).toBeNull();
    expect(after.yjsCheckpointAt).toBeNull();
  });

  it('dry-run rewrites nothing and records nothing', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/dry`, 'see </docs/api> here', admin, {});
    const pageId = created._id;

    const runner = new MigrationRunner(crowi, { dryRun: true });
    await runner.apply(wikilinkFormat);

    const page = await Page.findById(pageId).populate('revision');
    expect(page.revision.body).toBe('see </docs/api> here');
    expect(await MigrationApplication().countDocuments({ migrationId: 'wikilink-format' })).toBe(0);
  });
});
