import { crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { Fixture } from 'src/test/setup';

import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationRunner } from '../runner';
import { tocHtmlStrip } from './toc-html-strip';

/**
 * `toc-html-strip` preflight migration.
 *
 * The save path now strips inline HTML from heading labels (§B1), so a freshly
 * created page already has a clean `meta.toc`. To exercise the recovery path we
 * simulate the pre-fix state by writing a stale `meta.toc` (with HTML markup in
 * a label) onto the current revision, then assert the migration strips the
 * label text in place — **without** touching the stored `anchorId` (which still
 * matches the stored renderedAst heading id).
 */

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/toc-html-strip — framework wiring', () => {
  let Page;
  let Revision;
  let admin: UserDocument;

  const PATH_PREFIX = '/__toc-html-strip';

  // Replace the current revision's meta.toc with a stale (HTML-carrying) one,
  // mimicking what the pre-§B1 pipeline persisted.
  const corruptToc = async (pageId: unknown, toc: { level: number; text: string; anchorId: string }[]) => {
    const page = await Page.findById(pageId).select('revision').lean();
    await Revision.updateOne({ _id: page.revision }, { $set: { 'meta.toc': toc } });
  };

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const [user] = (await Fixture.generate('User', [
      { name: 'Toc Admin', username: 'toc-admin', email: 'toc-admin@example.com', admin: true },
    ])) as UserDocument[];
    admin = user;
  });

  beforeEach(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await MigrationApplication().deleteMany({ migrationId: 'toc-html-strip' });
  });

  afterAll(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await crowi.model('User').deleteOne({ _id: admin._id });
  });

  it('registry exposes toc-html-strip as a preflight migration', () => {
    expect(tocHtmlStrip.id).toBe('toc-html-strip');
    expect(tocHtmlStrip.layer).toBe('preflight');
  });

  it('a freshly-created page with an HTML heading has a clean meta.toc (save-path strip, §B1)', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/fresh`, '### <font color="1a73e8">Workspace</font>', admin, {});
    const page = await Page.findById(created._id).select('revision').lean();
    const revision = await Revision.findById(page.revision).select('meta.toc').lean();
    expect(revision.meta.toc).toEqual([{ level: 3, text: 'Workspace', anchorId: 'workspace' }]);
    // Not pending — fresh pages are already clean.
    expect(await new MigrationRunner(crowi).isPending(tocHtmlStrip)).toBe(false);
  });

  it('isPending detects a stale HTML-carrying meta.toc, clears after apply', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/stale`, '### <font color="1a73e8">Workspace</font>', admin, {});
    await corruptToc(created._id, [{ level: 3, text: '<font color="1a73e8">Workspace</font>', anchorId: 'font-color1a73e8workspacefont' }]);

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(tocHtmlStrip)).toBe(true);

    await runner.apply(tocHtmlStrip);
    expect(await runner.isPending(tocHtmlStrip)).toBe(false);
  });

  it('strips the HTML from meta.toc.text in place while PRESERVING the stored anchorId', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/regen`, '### <font color="1a73e8">Workspace</font>', admin, {});
    // The stored anchorId was slugged from the original HTML-laden text and
    // matches the stored renderedAst heading id; only `.text` is ugly.
    await corruptToc(created._id, [{ level: 3, text: '<font color="1a73e8">Workspace</font>', anchorId: 'font-color1a73e8workspacefont' }]);

    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(tocHtmlStrip);
    expect(outcome.result).toBe('applied');
    expect((outcome.stats['strip-toc-html'] as { transformed: number }).transformed).toBe(1);

    const page = await Page.findById(created._id).select('revision').lean();
    const revision = await Revision.findById(page.revision).select('meta.toc').lean();
    // Only `.text` was stripped — `anchorId` is preserved so the existing
    // stored-AST anchor link keeps resolving.
    expect(revision.meta.toc).toEqual([{ level: 3, text: 'Workspace', anchorId: 'font-color1a73e8workspacefont' }]);

    const recorded = await MigrationApplication().latestFor('toc-html-strip');
    expect(recorded?.result).toBe('applied');
    expect(recorded?.layer).toBe('preflight');
  });

  it('drops an HTML-only entry (strips to empty) but preserves anchorId on the kept entry', async () => {
    // A label that is only a known HTML tag strips to an empty label; the
    // migration omits it (an empty-text entry is unaddressable and unsavable).
    const created = await Page.createPage(`${PATH_PREFIX}/htmlonly`, ['## Keep me', '', '### <br>'].join('\n'), admin, {});
    await corruptToc(created._id, [
      { level: 2, text: 'Keep me', anchorId: 'keep-me' },
      { level: 3, text: '<br>', anchorId: 'br' },
    ]);

    const runner = new MigrationRunner(crowi);
    await runner.apply(tocHtmlStrip);

    const page = await Page.findById(created._id).select('revision').lean();
    const revision = await Revision.findById(page.revision).select('meta.toc').lean();
    expect(revision.meta.toc).toEqual([{ level: 2, text: 'Keep me', anchorId: 'keep-me' }]);
  });

  it('does NOT flag a heading with a literal `<` in its text (no false positive, no boot deadlock)', async () => {
    // `## price < 100` keeps a bare `<` in the TOC text; that is not a known
    // HTML tag, so the migration must not flag or change it.
    const created = await Page.createPage(`${PATH_PREFIX}/lt`, '## price < 100', admin, {});
    await corruptToc(created._id, [{ level: 2, text: 'price < 100', anchorId: 'price--100' }]);

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(tocHtmlStrip)).toBe(false);

    const report = await runner.detect(tocHtmlStrip);
    expect(report?.counts?.revisions).toBe(0);

    await runner.apply(tocHtmlStrip);
    const page = await Page.findById(created._id).select('revision').lean();
    const revision = await Revision.findById(page.revision).select('meta.toc').lean();
    expect(revision.meta.toc).toEqual([{ level: 2, text: 'price < 100', anchorId: 'price--100' }]);
  });

  it('preserves an unknown tag-like label (`<int>`) — not a known element', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/generic`, '## Using List<int> in C#', admin, {});
    await corruptToc(created._id, [{ level: 2, text: 'Using List<int> in C#', anchorId: 'using-listint-in-c' }]);

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(tocHtmlStrip)).toBe(false);

    await runner.apply(tocHtmlStrip);
    const page = await Page.findById(created._id).select('revision').lean();
    const revision = await Revision.findById(page.revision).select('meta.toc').lean();
    expect(revision.meta.toc).toEqual([{ level: 2, text: 'Using List<int> in C#', anchorId: 'using-listint-in-c' }]);
  });

  it('leaves a page without HTML in its toc untouched (not pending)', async () => {
    await Page.createPage(`${PATH_PREFIX}/plain`, '## Plain Heading', admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(tocHtmlStrip)).toBe(false);
    const report = await runner.detect(tocHtmlStrip);
    expect(report?.counts?.revisions).toBe(0);
  });

  it('detect counts the stale revisions', async () => {
    const c1 = await Page.createPage(`${PATH_PREFIX}/d1`, '### <font>A</font>', admin, {});
    await corruptToc(c1._id, [{ level: 3, text: '<font>A</font>', anchorId: 'fonta' }]);
    const c2 = await Page.createPage(`${PATH_PREFIX}/d2`, '## Clean', admin, {});
    // c2 stays clean.
    void c2;

    const runner = new MigrationRunner(crowi);
    const report = await runner.detect(tocHtmlStrip);
    expect(report?.counts?.revisions).toBe(1);
  });

  it('is idempotent — a second run is a no-op (not pending)', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/idem`, '### <font>X</font>', admin, {});
    await corruptToc(created._id, [{ level: 3, text: '<font>X</font>', anchorId: 'fontx' }]);
    const runner = new MigrationRunner(crowi);

    await runner.apply(tocHtmlStrip);
    expect(await runner.isPending(tocHtmlStrip)).toBe(false);

    const second = await runner.apply(tocHtmlStrip);
    expect(second.stats['strip-toc-html']).toBeUndefined();
  });

  it('dry-run strips nothing and records nothing', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/dry`, '### <font>Y</font>', admin, {});
    await corruptToc(created._id, [{ level: 3, text: '<font>Y</font>', anchorId: 'fonty' }]);

    const runner = new MigrationRunner(crowi, { dryRun: true });
    await runner.apply(tocHtmlStrip);

    const page = await Page.findById(created._id).select('revision').lean();
    const revision = await Revision.findById(page.revision).select('meta.toc').lean();
    expect(revision.meta.toc[0].text).toBe('<font>Y</font>');
    expect(await MigrationApplication().countDocuments({ migrationId: 'toc-html-strip' })).toBe(0);
  });
});
