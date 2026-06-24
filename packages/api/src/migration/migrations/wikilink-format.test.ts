import { KNOWN_HTML_ELEMENTS } from '@crowi/api-contract';
import type { MigrationApplicationModel } from 'src/models/migration-application';
import type { UserDocument } from 'src/models/user';
import { crowi, Fixture } from 'src/test/setup';
import { MigrationRunner } from '../runner';
import { bodyHasRewritableWikilink, rewriteAndDetect, rewriteWikilinks, shouldRewriteWikilink, wikilinkFormat } from './wikilink-format';

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

describe('migration/wikilink-format — code-region exclusion (pure)', () => {
  describe('basics', () => {
    it('suppresses a token inside a fenced code block', () => {
      const body = 'intro\n```tsx\n</AppShell>\n```\nend';
      expect(rewriteWikilinks(body)).toBe(body);
      expect(bodyHasRewritableWikilink(body)).toBe(false);
    });

    it('suppresses a token inside an inline code span (incl. an uppercase, non-HTML name)', () => {
      // `</font>` is HTML-filtered anyway; `</AppShell>` is the load-bearing
      // one — uppercase, NOT in KNOWN_HTML_ELEMENTS, so only code-segmentation
      // protects it.
      const body = 'see `</font>` and `</AppShell>` examples';
      expect(rewriteWikilinks(body)).toBe(body);
      expect(bodyHasRewritableWikilink(body)).toBe(false);
    });

    it('suppresses a token after an unclosed fence (code to EOF)', () => {
      const body = 'intro\n```tsx\n</AppShell>\nmore\n';
      expect(rewriteWikilinks(body)).toBe(body);
      expect(bodyHasRewritableWikilink(body)).toBe(false);
    });

    it('does NOT protect a token after an unmatched single backtick (no over-suppression)', () => {
      // A lone backtick with no closer is not a code span, so the following
      // `</AppShell>` is rewritten as a real wikilink.
      const body = 'a ` then </AppShell> here';
      expect(rewriteWikilinks(body)).toBe('a ` then [[/AppShell]] here');
      expect(bodyHasRewritableWikilink(body)).toBe(true);
    });

    it('does NOT exclude indented code (renderer divergence) — the token is still rewritten', () => {
      const body = 'para\n\n    </AppShell>\n';
      expect(rewriteWikilinks(body)).toBe('para\n\n    [[/AppShell]]\n');
    });

    it('rewrites a genuine wikilink on a 4-space paragraph-continuation line (no over-suppression)', () => {
      const body = 'lead\n    see </docs/api>\n';
      expect(rewriteWikilinks(body)).toBe('lead\n    see [[/docs/api]]\n');
    });
  });

  describe('failure-mode regressions (the three bugs the same-length-fill scheme drops)', () => {
    it('(a①) preserves two adjacent inline spans byte-for-byte (no merge / drop)', () => {
      const body = '`</A>` `</B>`';
      const result = rewriteAndDetect(body);
      expect(result.body).toBe(body);
      expect(result.body).toContain('`</A>`');
      expect(result.body).toContain('`</B>`');
      expect(result.occurrences).toEqual([]);
    });

    it('(a②) preserves a fence immediately followed by an inline span byte-for-byte', () => {
      const body = '```tsx\n</A>\n```\n`</B>`';
      const result = rewriteAndDetect(body);
      expect(result.body).toBe(body);
      expect(result.occurrences).toEqual([]);
    });

    it('(b) does not swap two code regions when an inline span precedes a fence', () => {
      const body = '`</A>` text\n```tsx\n</B>\n```\n';
      const result = rewriteAndDetect(body);
      expect(result.body).toBe(body);
      // Each region stays in place, byte-identical.
      expect(result.body.indexOf('`</A>`')).toBeLessThan(result.body.indexOf('</B>'));
    });

    it('(c) a page whose target tokens are all inside code does not pend', () => {
      const body = 'doc\n```tsx\n</AppShell>\n```\nand `</Widget>` inline';
      expect(rewriteWikilinks(body)).toBe(body);
      expect(bodyHasRewritableWikilink(body)).toBe(false);
    });

    it('(d) rewrites a real out-of-code token that comes BEFORE the code region, keeping code byte-identical', () => {
      const body = 'see </docs/api> for details\n```tsx\n</AppShell>\n```';
      const result = rewriteAndDetect(body);
      expect(result.body).toBe('see [[/docs/api]] for details\n```tsx\n</AppShell>\n```');
      expect(result.occurrences).toEqual([{ raw: '</docs/api>', path: '/docs/api', alias: undefined }]);
      // The fence is preserved verbatim.
      expect(result.body).toContain('```tsx\n</AppShell>\n```');
    });
  });

  describe('by-reference / idempotency', () => {
    it('returns the input by reference when only code-region tokens exist', () => {
      const body = '```tsx\n</AppShell>\n```';
      const result = rewriteAndDetect(body);
      expect(result.body).toBe(body); // referential equality (no rewrite happened)
    });

    it('is idempotent across two passes when a real token sits beside a code region', () => {
      const body = 'see </docs/api>\n```tsx\n</AppShell>\n```';
      const once = rewriteWikilinks(body);
      expect(rewriteWikilinks(once)).toBe(once);
    });
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
  // A non-admin author distinct from the migration acting user (the oldest
  // admin). Pages created by this user have `lastUpdateUser === author`, so the
  // preserve-timestamps assertion is non-vacuous (without the fix the apply
  // would rewrite `lastUpdateUser` to `admin`).
  let author: UserDocument;

  const PATH_PREFIX = '/__wikilink-migration';

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const [adminUser, authorUser] = (await Fixture.generate('User', [
      { name: 'Wikilink Admin', username: 'wikilink-admin', email: 'wikilink-admin@example.com', admin: true },
      { name: 'Wikilink Author', username: 'wikilink-author', email: 'wikilink-author@example.com', admin: false },
    ])) as UserDocument[];
    admin = adminUser;
    author = authorUser;
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
    await crowi.model('User').deleteOne({ _id: author._id });
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

  describe('code-region exclusion (Mongo wiring)', () => {
    it('a page whose only `</…>` token is inside a tsx fence is NOT pending and applies clean', async () => {
      const body = 'Component usage:\n```tsx\n<AppShell>\n  <Page />\n</AppShell>\n```\n';
      await Page.createPage(`${PATH_PREFIX}/fence-only`, body, admin, {});

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(wikilinkFormat)).toBe(false);

      const report = await runner.detect(wikilinkFormat);
      expect(report?.counts?.pages).toBe(0);

      const outcome = await runner.apply(wikilinkFormat);
      expect(outcome.result).toBe('detected-clean');
      expect(outcome.stats['rewrite-wikilink']).toBeUndefined();
    });

    it('rewrites only the out-of-code token and keeps the fence + inline span byte-identical', async () => {
      const fence = '```tsx\n</AppShell>\n```';
      const inline = '`</Widget>`';
      const body = `see </docs/api> for details\n${fence}\nand ${inline} inline`;
      const created = await Page.createPage(`${PATH_PREFIX}/mixed-code`, body, admin, {});

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(wikilinkFormat)).toBe(true);
      await runner.apply(wikilinkFormat);

      const page = await Page.findById(created._id).populate('revision');
      expect(page.revision.body).toBe(`see [[/docs/api]] for details\n${fence}\nand ${inline} inline`);
      // (f) the code regions survive the apply byte-for-byte.
      expect(page.revision.body).toContain(fence);
      expect(page.revision.body).toContain(inline);
    });
  });

  describe('apply preserves updatedAt / lastUpdateUser (preserve-in-place)', () => {
    // A fixed past sentinel so "unchanged" is distinguishable from "bumped to now".
    const PAST = new Date('2020-01-02T03:04:05.000Z');

    it('keeps the original lastUpdateUser (a non-bot author) and the past updatedAt after apply', async () => {
      // (i) create the page as `author` (non-admin) so lastUpdateUser != the
      // migration acting user (the oldest admin).
      const created = await Page.createPage(`${PATH_PREFIX}/preserve`, 'see </docs/api> here', author, {});
      const pageId = created._id;

      // Sanity: before apply, lastUpdateUser is the author, NOT the admin
      // (read the stored ref, which is a plain ObjectId).
      const before = await Page.findById(pageId).select('lastUpdateUser').lean();
      expect(String(before.lastUpdateUser)).toBe(String(author._id));
      expect(String(before.lastUpdateUser)).not.toBe(String(admin._id));

      // (ii) pin updatedAt to a fixed past sentinel.
      await Page.updateOne({ _id: pageId }, { $set: { updatedAt: PAST } });

      await new MigrationRunner(crowi).apply(wikilinkFormat);

      const after = await Page.findById(pageId).populate('revision');
      // The body was rewritten …
      expect(after.revision.body).toBe('see [[/docs/api]] here');
      // (iii) … but updatedAt and lastUpdateUser are preserved.
      expect(new Date(after.updatedAt).toISOString()).toBe(PAST.toISOString());
      expect(String(after.lastUpdateUser)).toBe(String(author._id));
      expect(String(after.lastUpdateUser)).not.toBe(String(admin._id));
    });

    it('(iv) the search-index path sees the ORIGINAL updatedAt (no Mongo/index divergence)', async () => {
      const created = await Page.createPage(`${PATH_PREFIX}/preserve-index`, 'link </docs/api> here', author, {});
      const pageId = created._id;
      await Page.updateOne({ _id: pageId }, { $set: { updatedAt: PAST } });

      // Install a capturing fake searcher so we can observe the doc that
      // indexPageInSearch builds from the in-memory page the event carries.
      const registries = (crowi as unknown as { pluginRegistries: { active: { search: unknown } } }).pluginRegistries;
      const previous = registries.active.search;
      const indexed: { id: string; updatedAt: unknown }[] = [];
      registries.active.search = {
        index: async (doc: { id: string; meta?: { updated_at?: unknown } }) => {
          indexed.push({ id: doc.id, updatedAt: doc.meta?.updated_at });
        },
        remove: async () => undefined,
        query: async () => ({ total: 0, hits: [] }),
      };

      try {
        await new MigrationRunner(crowi).apply(wikilinkFormat);
        // indexPageInSearch runs as a tracked fire-and-forget side effect.
        await crowi.drainSideEffects();
      } finally {
        registries.active.search = previous;
      }

      const entry = indexed.find((e) => e.id === String(pageId));
      expect(entry).toBeDefined();
      // The indexed updated_at is the ORIGINAL past value — never bumped to now.
      expect(new Date(entry?.updatedAt as Date).toISOString()).toBe(PAST.toISOString());
    });

    it('does not overwrite a legacy null lastUpdateUser with undefined', async () => {
      const created = await Page.createPage(`${PATH_PREFIX}/legacy-null`, 'see </docs/api> here', author, {});
      const pageId = created._id;
      // Simulate a legacy page with no lastUpdateUser / updatedAt.
      await Page.updateOne({ _id: pageId }, { $unset: { lastUpdateUser: '', updatedAt: '' } });

      await new MigrationRunner(crowi).apply(wikilinkFormat);

      const after = await Page.findById(pageId).populate('revision');
      expect(after.revision.body).toBe('see [[/docs/api]] here');
      // Preserve-in-place skips the assignment entirely, so the field stays
      // null/undefined — never written as `undefined` on top of a legacy null.
      expect(after.lastUpdateUser == null).toBe(true);
    });
  });
});
