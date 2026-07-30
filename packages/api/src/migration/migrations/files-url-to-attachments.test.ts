import { app, crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { Fixture } from 'src/test/setup';
import request from 'supertest';

import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationRunner } from '../runner';
import { bodyHasRewritableFilesUrl, filesUrlToAttachments, rewriteFilesUrls } from './files-url-to-attachments';

/**
 * feature-migration-files-url-rewrite — `files-url-to-attachments` preflight
 * migration + the `/files/:id` → 302 redirect safety net.
 *
 * Three halves:
 *   1. The pure URL-rewrite logic (`rewriteFilesUrls` / `bodyHasRewritableFilesUrl`)
 *      with an explicit `origins` allow-list, so the CLIENT_URL-set and
 *      CLIENT_URL-unset (`[]`) cases are both covered without env juggling.
 *   2. The framework wiring (`isPending` / `detect` / stage), reusing the live
 *      `crowi` whose `CLIENT_URL` is `http://localhost:13001` (test/setup.ts).
 *   3. The runtime `/files/:id` → 302 `/api/attachments/:id` redirect.
 */

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

// Two distinct 24-hex ObjectId-shaped ids used across the pure tests.
const ID_A = '695203853dc1f10014e3c488';
const ID_B = '6a338b6c0d6544b210d37e13';

// The self-host origin the live test crowi resolves (CLIENT_URL = BASE_URL).
const SELF_ORIGIN = 'http://localhost:13001';

describe('migration/files-url-to-attachments — rewriteFilesUrls (pure)', () => {
  const origins = ['https://wiki.example.com'];

  it('returns the input unchanged (by reference) when there is no /files/ at all', () => {
    const body = 'no attachment URLs here, just text';
    const result = rewriteFilesUrls(body, origins);
    expect(result.body).toBe(body);
    expect(result.counts).toEqual({ relative: 0, selfHostAbsolute: 0, externalSkipped: 0 });
  });

  it('rewrites a relative /files/<id> in a Markdown image', () => {
    const result = rewriteFilesUrls(`![pic](/files/${ID_A})`, origins);
    expect(result.body).toBe(`![pic](/api/attachments/${ID_A})`);
    expect(result.counts.relative).toBe(1);
  });

  it('rewrites a relative /files/<id> in a Markdown link', () => {
    const result = rewriteFilesUrls(`see [the file](/files/${ID_A}) here`, origins);
    expect(result.body).toBe(`see [the file](/api/attachments/${ID_A}) here`);
    expect(result.counts.relative).toBe(1);
  });

  it('relativises a self-host absolute URL (drops the host)', () => {
    const result = rewriteFilesUrls(`![pic](https://wiki.example.com/files/${ID_A})`, origins);
    expect(result.body).toBe(`![pic](/api/attachments/${ID_A})`);
    expect(result.counts.selfHostAbsolute).toBe(1);
    expect(result.counts.relative).toBe(0);
  });

  it('leaves an external-host absolute URL untouched (no false-positive)', () => {
    const body = `![pic](https://other.example.org/files/${ID_A})`;
    const result = rewriteFilesUrls(body, origins);
    expect(result.body).toBe(body);
    expect(result.counts.externalSkipped).toBe(1);
    expect(result.counts.relative).toBe(0);
    expect(result.counts.selfHostAbsolute).toBe(0);
  });

  it('does NOT touch an already-rewritten /api/attachments/<id> URL', () => {
    const body = `![pic](/api/attachments/${ID_A})`;
    expect(rewriteFilesUrls(body, origins).body).toBe(body);
  });

  it('does NOT touch a body already carrying the legacy (pre-cutover) /api/v2/attachments/<id> form', () => {
    // A body rewritten by a copy of this migration that ran before the
    // /api/v2 -> /api cutover doesn't match the /files/ prefilter, so it is
    // never re-visited here. That legacy form is permanently handled by the
    // reader dual-accept (`ATTACHMENT_URI_RE`) and the web canonicalization
    // helper (`attachment-url.ts`), not by re-running this migration.
    const body = `![pic](/api/v2/attachments/${ID_A})`;
    expect(rewriteFilesUrls(body, origins).body).toBe(body);
  });

  it('is idempotent — a second pass over the rewritten body is a no-op', () => {
    const once = rewriteFilesUrls(`![a](/files/${ID_A}) and [b](https://wiki.example.com/files/${ID_B})`, origins);
    expect(once.body).toBe(`![a](/api/attachments/${ID_A}) and [b](/api/attachments/${ID_B})`);
    const twice = rewriteFilesUrls(once.body, origins);
    expect(twice.body).toBe(once.body);
    expect(twice.counts).toEqual({ relative: 0, selfHostAbsolute: 0, externalSkipped: 0 });
  });

  it('handles relative + self-host + external in one body', () => {
    const body = `![rel](/files/${ID_A})\n` + `![self](https://wiki.example.com/files/${ID_B})\n` + `![ext](https://other.example.org/files/${ID_A})`;
    const result = rewriteFilesUrls(body, origins);
    expect(result.body).toBe(`![rel](/api/attachments/${ID_A})\n` + `![self](/api/attachments/${ID_B})\n` + `![ext](https://other.example.org/files/${ID_A})`);
    expect(result.counts).toEqual({ relative: 1, selfHostAbsolute: 1, externalSkipped: 1 });
  });

  it('preserves a trailing query/fragment after the id', () => {
    const result = rewriteFilesUrls(`![pic](/files/${ID_A}?w=200#frag)`, origins);
    expect(result.body).toBe(`![pic](/api/attachments/${ID_A}?w=200#frag)`);
  });

  it('does not match a 24-hex that is not under /files/', () => {
    const body = `[plain](/pages/${ID_A})`;
    expect(rewriteFilesUrls(body, origins).body).toBe(body);
  });

  describe('CLIENT_URL unset (origins = []) — relative only, absolute skipped', () => {
    it('rewrites the relative URL but leaves the self-host absolute one alone', () => {
      const body = `![rel](/files/${ID_A}) and ![abs](https://wiki.example.com/files/${ID_B})`;
      const result = rewriteFilesUrls(body, []);
      // The absolute URL can't be classified as self without an origin list, so
      // it falls through to the external (untouched) branch.
      expect(result.body).toBe(`![rel](/api/attachments/${ID_A}) and ![abs](https://wiki.example.com/files/${ID_B})`);
      expect(result.counts.relative).toBe(1);
      expect(result.counts.selfHostAbsolute).toBe(0);
      expect(result.counts.externalSkipped).toBe(1);
    });
  });

  describe('code-region exclusion (via rewriteOutsideCode)', () => {
    it('does NOT rewrite a /files/<id> written inside a fenced code block (byte-identical, no count)', () => {
      const body = 'Embed an image like:\n```md\n![pic](/files/' + ID_A + ')\n```\n';
      const result = rewriteFilesUrls(body, origins);
      expect(result.body).toBe(body); // by reference — nothing outside code matched
      expect(result.counts).toEqual({ relative: 0, selfHostAbsolute: 0, externalSkipped: 0 });
    });

    it('does NOT rewrite a /files/<id> written inside an inline code span', () => {
      const body = `use \`![pic](/files/${ID_A})\` in your page`;
      const result = rewriteFilesUrls(body, origins);
      expect(result.body).toBe(body);
      expect(result.counts.relative).toBe(0);
    });

    it('rewrites the genuine out-of-code URL and keeps the fenced one byte-identical (mixed page)', () => {
      const fence = '```md\n![ex](/files/' + ID_B + ')\n```';
      const body = `![real](/files/${ID_A})\n${fence}\n`;
      const result = rewriteFilesUrls(body, origins);
      expect(result.body).toBe(`![real](/api/attachments/${ID_A})\n${fence}\n`);
      // The fenced URL is untouched; only the genuine one is counted.
      expect(result.counts.relative).toBe(1);
      // The code region survives verbatim.
      expect(result.body).toContain(fence);
    });

    it('preserves adjacent code regions and rejoins byte-identically', () => {
      // inline span, then a genuine URL, then a fence — order + bytes preserved.
      const inline = '`![doc](/files/' + ID_A + ')`';
      const fence = '```\n![doc](/files/' + ID_B + ')\n```';
      const body = `${inline} then ![real](/files/${ID_A}) then\n${fence}\n`;
      const result = rewriteFilesUrls(body, origins);
      expect(result.body).toBe(`${inline} then ![real](/api/attachments/${ID_A}) then\n${fence}\n`);
      expect(result.body).toContain(inline);
      expect(result.body).toContain(fence);
    });

    it('returns the body BY REFERENCE when every /files/<id> is inside code', () => {
      const body = 'fenced:\n```\n![a](/files/' + ID_A + ')\n```\nand inline `![b](/files/' + ID_B + ')`';
      const result = rewriteFilesUrls(body, origins);
      expect(result.body).toBe(body); // same reference
    });

    it('is idempotent — a second pass over a mixed (code + genuine) body is a no-op', () => {
      const fence = '```\n![ex](/files/' + ID_B + ')\n```';
      const once = rewriteFilesUrls(`![real](/files/${ID_A})\n${fence}\n`, origins);
      const twice = rewriteFilesUrls(once.body, origins);
      expect(twice.body).toBe(once.body);
      expect(twice.counts).toEqual({ relative: 0, selfHostAbsolute: 0, externalSkipped: 0 });
    });

    // AD-2 (accepted divergence, documented in
    // .feature-state/specs/feature-migration-rewrite-outside-code.md §"AD-2"):
    // when the Markdown image's alt text contains an inline-code span,
    // `splitInlineCode` carves that span out as a code segment, so the
    // `![see ` head and the `](/files/<id>)` URL land in two SEPARATE non-code
    // segments. `buildFilesUrlRegex` matches head + URL as one unit, so neither
    // segment matches on its own and the genuine URL is left unrewritten. This
    // is a per-segment false-negative (the URL stays 404, no data corruption),
    // pinned here so the behaviour change is intentional, not a silent
    // regression.
    it('accepted divergence: alt-text-with-inline-code straddles segment boundary — URL left unrewritten', () => {
      const body = `![see \`code\`](/files/${ID_A})`;
      const result = rewriteFilesUrls(body, origins);
      // The genuine /files/<id> is NOT rewritten — accepted false-negative.
      expect(result.body).toBe(body);
      expect(result.counts.relative).toBe(0);
    });
  });
});

describe('migration/files-url-to-attachments — bodyHasRewritableFilesUrl (pure verdict)', () => {
  const origins = ['https://wiki.example.com'];

  it('is false when there is no /files/ substring at all', () => {
    expect(bodyHasRewritableFilesUrl('plain text', origins)).toBe(false);
    expect(bodyHasRewritableFilesUrl(`![v2](/api/attachments/${ID_A})`, origins)).toBe(false);
  });

  it('is false when the only /files/ URL is external (would not be rewritten)', () => {
    expect(bodyHasRewritableFilesUrl(`![ext](https://other.example.org/files/${ID_A})`, origins)).toBe(false);
  });

  it('is true for a relative /files/<id>', () => {
    expect(bodyHasRewritableFilesUrl(`![rel](/files/${ID_A})`, origins)).toBe(true);
  });

  it('is true for a self-host absolute /files/<id>', () => {
    expect(bodyHasRewritableFilesUrl(`![self](https://wiki.example.com/files/${ID_A})`, origins)).toBe(true);
  });

  it('with origins=[] is true only for the relative URL', () => {
    expect(bodyHasRewritableFilesUrl(`![rel](/files/${ID_A})`, [])).toBe(true);
    expect(bodyHasRewritableFilesUrl(`![abs](https://wiki.example.com/files/${ID_A})`, [])).toBe(false);
  });
});

describe('migration/files-url-to-attachments — framework wiring', () => {
  let Page;
  let Revision;
  let admin: UserDocument;

  const PATH_PREFIX = '/__files-url-migration';

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const [user] = (await Fixture.generate('User', [
      { name: 'Files Url Admin', username: 'files-url-admin', email: 'files-url-admin@example.com', admin: true },
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
    await MigrationApplication().deleteMany({ migrationId: 'files-url-to-attachments' });
  });

  afterAll(async () => {
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await Revision.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
    await crowi.model('User').deleteOne({ _id: admin._id });
  });

  it('registry exposes files-url-to-attachments as a preflight migration with the right range', () => {
    expect(filesUrlToAttachments.id).toBe('files-url-to-attachments');
    expect(filesUrlToAttachments.layer).toBe('preflight');
    expect(filesUrlToAttachments.fromVersion).toBe('1.x');
    expect(filesUrlToAttachments.toVersion).toBe('2.1');
  });

  it('isPending detects a page with a relative /files/<id>, clean once rewritten', async () => {
    await Page.createPage(`${PATH_PREFIX}/rel`, `![pic](/files/${ID_A})`, admin, {});

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(filesUrlToAttachments)).toBe(true);

    await runner.apply(filesUrlToAttachments);
    expect(await runner.isPending(filesUrlToAttachments)).toBe(false);
  });

  it('isPending detects a self-host absolute URL (CLIENT_URL host)', async () => {
    await Page.createPage(`${PATH_PREFIX}/self`, `![pic](${SELF_ORIGIN}/files/${ID_A})`, admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(filesUrlToAttachments)).toBe(true);
  });

  it('isPending is false for a page whose only /files/ URL is external (no boot deadlock)', async () => {
    await Page.createPage(`${PATH_PREFIX}/ext`, `![pic](https://other.example.org/files/${ID_A})`, admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(filesUrlToAttachments)).toBe(false);

    const report = await runner.detect(filesUrlToAttachments);
    expect(report?.counts?.pages).toBe(0);

    const outcome = await runner.apply(filesUrlToAttachments);
    expect(outcome.result).toBe('detected-clean');
    expect(outcome.stats['rewrite-files-url']).toBeUndefined();
  });

  it('isPending is false for a page already in the current /api/attachments/<id> form', async () => {
    await Page.createPage(`${PATH_PREFIX}/v2`, `![pic](/api/attachments/${ID_A})`, admin, {});
    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(filesUrlToAttachments)).toBe(false);
  });

  it('detect reports affected pages + the rewrite breakdown', async () => {
    await Page.createPage(`${PATH_PREFIX}/d1`, `![a](/files/${ID_A}) [b](${SELF_ORIGIN}/files/${ID_B})`, admin, {});
    await Page.createPage(`${PATH_PREFIX}/d2`, `![ext](https://other.example.org/files/${ID_A})`, admin, {});
    await Page.createPage(`${PATH_PREFIX}/d3`, 'no files urls here', admin, {});

    const runner = new MigrationRunner(crowi);
    const report = await runner.detect(filesUrlToAttachments);
    // d1 is the only rewritable page; d2 is external-only, d3 has none.
    expect(report?.counts?.pages).toBe(1);
    expect(report?.counts?.relative).toBe(1);
    expect(report?.counts?.selfHostAbsolute).toBe(1);
    expect(report?.counts?.externalSkipped).toBe(1);
    expect(report?.counts?.rewrites).toBe(2);
  });

  it('rewrites the body via the updatePage path (relative + self-host) and records the application', async () => {
    const created = await Page.createPage(
      `${PATH_PREFIX}/rewrite`,
      `![rel](/files/${ID_A}) and ![self](${SELF_ORIGIN}/files/${ID_B}) and ![ext](https://other.example.org/files/${ID_A})`,
      admin,
      {},
    );
    const pageId = created._id;

    const runner = new MigrationRunner(crowi);
    const outcome = await runner.apply(filesUrlToAttachments);
    expect(outcome.result).toBe('applied');
    expect((outcome.stats['rewrite-files-url'] as { transformed: number }).transformed).toBe(1);

    const page = await Page.findById(pageId).populate('revision');
    expect(page.revision.body).toBe(
      `![rel](/api/attachments/${ID_A}) and ![self](/api/attachments/${ID_B}) and ![ext](https://other.example.org/files/${ID_A})`,
    );

    const recorded = await MigrationApplication().latestFor('files-url-to-attachments');
    expect(recorded?.result).toBe('applied');
    expect(recorded?.layer).toBe('preflight');
  });

  it('is idempotent — a second apply rewrites nothing', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/idem`, `![pic](/files/${ID_A})`, admin, {});
    const pageId = created._id;

    const runner = new MigrationRunner(crowi);
    await runner.apply(filesUrlToAttachments);
    const after1 = await Page.findById(pageId).populate('revision');
    expect(after1.revision.body).toBe(`![pic](/api/attachments/${ID_A})`);

    // Re-applying must not double-rewrite: the verdict is now false, so the
    // stage never runs and the body is byte-identical.
    expect(await runner.isPending(filesUrlToAttachments)).toBe(false);
    await runner.apply(filesUrlToAttachments);
    const after2 = await Page.findById(pageId).populate('revision');
    expect(after2.revision.body).toBe(`![pic](/api/attachments/${ID_A})`);
  });

  it('nulls yjsState / yjsCheckpointAt on the rewritten page (Yjs invalidation)', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/yjs`, `![pic](/files/${ID_A})`, admin, {});
    const pageId = created._id;

    await Page.updateOne({ _id: pageId }, { $set: { yjsState: Buffer.from([1, 2, 3]), yjsCheckpointAt: new Date() } });
    const before = await Page.findById(pageId).select('yjsState yjsCheckpointAt');
    expect(before.yjsState).not.toBeNull();
    expect(before.yjsCheckpointAt).not.toBeNull();

    await new MigrationRunner(crowi).apply(filesUrlToAttachments);

    const after = await Page.findById(pageId).select('yjsState yjsCheckpointAt');
    expect(after.yjsState).toBeNull();
    expect(after.yjsCheckpointAt).toBeNull();
  });

  it('dry-run rewrites nothing and records nothing', async () => {
    const created = await Page.createPage(`${PATH_PREFIX}/dry`, `![pic](/files/${ID_A})`, admin, {});
    const pageId = created._id;

    const runner = new MigrationRunner(crowi, { dryRun: true });
    await runner.apply(filesUrlToAttachments);

    const page = await Page.findById(pageId).populate('revision');
    expect(page.revision.body).toBe(`![pic](/files/${ID_A})`);
    expect(await MigrationApplication().countDocuments({ migrationId: 'files-url-to-attachments' })).toBe(0);
  });

  describe('code-region exclusion (Mongo wiring)', () => {
    it('a page whose only /files/<id> is inside a fenced block is NOT pending and applies clean', async () => {
      const body = 'Embed an image:\n```md\n![pic](/files/' + ID_A + ')\n```\n';
      await Page.createPage(`${PATH_PREFIX}/fence-only`, body, admin, {});

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(filesUrlToAttachments)).toBe(false);

      const report = await runner.detect(filesUrlToAttachments);
      expect(report?.counts?.pages).toBe(0);

      const outcome = await runner.apply(filesUrlToAttachments);
      expect(outcome.result).toBe('detected-clean');
      expect(outcome.stats['rewrite-files-url']).toBeUndefined();
    });

    it('a page whose only /files/<id> is inside an inline span is NOT pending', async () => {
      await Page.createPage(`${PATH_PREFIX}/inline-only`, `write \`![pic](/files/${ID_A})\` like this`, admin, {});
      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(filesUrlToAttachments)).toBe(false);
    });

    it('apply leaves a fenced-only page byte-identical', async () => {
      const body = '```md\n![pic](/files/' + ID_A + ')\n```\n';
      const created = await Page.createPage(`${PATH_PREFIX}/fence-noop`, body, admin, {});

      await new MigrationRunner(crowi).apply(filesUrlToAttachments);

      const page = await Page.findById(created._id).populate('revision');
      expect(page.revision.body).toBe(body);
    });

    it('rewrites only the out-of-code URL and keeps the fence + inline span byte-identical (mixed page)', async () => {
      const fence = '```md\n![ex](/files/' + ID_B + ')\n```';
      const inline = '`![doc](/files/' + ID_A + ')`';
      const body = `![real](/files/${ID_A})\n${fence}\nand ${inline} inline`;
      const created = await Page.createPage(`${PATH_PREFIX}/mixed-code`, body, admin, {});

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(filesUrlToAttachments)).toBe(true);
      await runner.apply(filesUrlToAttachments);

      const page = await Page.findById(created._id).populate('revision');
      expect(page.revision.body).toBe(`![real](/api/attachments/${ID_A})\n${fence}\nand ${inline} inline`);
      // The code regions survive the apply byte-for-byte.
      expect(page.revision.body).toContain(fence);
      expect(page.revision.body).toContain(inline);
    });
  });
});

describe('GET /files/:id — 302 redirect to /api/attachments/:id (safety net)', () => {
  it('redirects a relative /files/<24hex> GET to /api/attachments/<24hex> with 302', async () => {
    const res = await request(app).get(`/files/${ID_A}`).redirects(0); // don't follow — assert the 302 itself
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/attachments/${ID_A}`);
  });

  it('does not require auth for the redirect itself (auth is deferred to the target)', async () => {
    // No Authorization header — the redirect still emits 302 (the v2 target
    // enforces JWT, not this redirect).
    const res = await request(app).get(`/files/${ID_B}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/attachments/${ID_B}`);
  });

  it('does not match a non-24-hex /files/ path', async () => {
    const res = await request(app).get('/files/not-a-hex-id').redirects(0);
    expect(res.status).not.toBe(302);
  });
});
