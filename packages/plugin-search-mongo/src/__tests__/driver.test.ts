import mongoose, { Schema, Types } from 'mongoose';

import type { PluginContext, SearchQuery } from '@crowi/plugin-api';

import { buildSnippet, createMongoSearchDriver } from '../driver';
import { keywordRegex } from '../query-builder';
import { startTestMongo, type TestMongo } from './setup';

// Minimal Page / Revision document shapes + schemas mirroring the fields
// the driver reads.
interface TestPage {
  path: string;
  revision?: Types.ObjectId;
  redirectTo?: string;
  status: string;
  grant: number;
  grantedUsers: Types.ObjectId[];
  creator?: Types.ObjectId;
}
interface TestRevision {
  path?: string;
  body: string;
}

const PageSchema = new Schema<TestPage>(
  {
    path: { type: String, required: true },
    revision: { type: Schema.Types.ObjectId, ref: 'Revision' },
    redirectTo: { type: String },
    status: { type: String, default: 'published' },
    grant: { type: Number, default: 1 },
    grantedUsers: [{ type: Schema.Types.ObjectId }],
    creator: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);
const RevisionSchema = new Schema<TestRevision>({
  path: { type: String },
  body: { type: String, default: '' },
});

let testMongo: TestMongo;
let Page: mongoose.Model<TestPage>;
let Revision: mongoose.Model<TestRevision>;

/** Build a fake PluginContext exposing just `model()` + `log`. */
function makeCtx(): PluginContext {
  const noop = () => {
    /* noop */
  };
  return {
    model: (name: string) => (name === 'Page' ? Page : Revision),
    log: { debug: noop, info: noop, warn: noop, error: noop },
  } as unknown as PluginContext;
}

async function seedPage(opts: {
  path: string;
  body?: string;
  grant?: number;
  status?: string;
  redirectTo?: string;
  creator?: Types.ObjectId;
  grantedUsers?: Types.ObjectId[];
}): Promise<void> {
  const revision = await Revision.create({ path: opts.path, body: opts.body ?? '' });
  await Page.create({
    path: opts.path,
    revision: revision._id,
    status: opts.status ?? 'published',
    grant: opts.grant ?? 1,
    redirectTo: opts.redirectTo,
    creator: opts.creator,
    grantedUsers: opts.grantedUsers ?? [],
  });
}

beforeAll(async () => {
  testMongo = await startTestMongo();
  Page = mongoose.model('Page', PageSchema);
  Revision = mongoose.model('Revision', RevisionSchema);
});

afterAll(async () => {
  await testMongo.stop();
});

afterEach(async () => {
  await Page.deleteMany({});
  await Revision.deleteMany({});
});

describe('buildSnippet', () => {
  it('wraps the first match in <mark> with ellipsis context', () => {
    const long = `${'x'.repeat(100)} keyword ${'y'.repeat(100)}`;
    const snippet = buildSnippet(long, keywordRegex('keyword') as RegExp);
    expect(snippet).toContain('<mark>keyword</mark>');
    expect(snippet?.startsWith('…')).toBe(true);
    expect(snippet?.endsWith('…')).toBe(true);
  });

  it('returns undefined when there is no match', () => {
    expect(buildSnippet('nothing here', keywordRegex('zzz') as RegExp)).toBeUndefined();
  });
});

describe('mongo search driver — query()', () => {
  it('index() / remove() are no-ops and never throw', async () => {
    const driver = createMongoSearchDriver(makeCtx());
    await expect(driver.index({ id: 'x', path: '/x', body: 'b' })).resolves.toBeUndefined();
    await expect(driver.remove('x')).resolves.toBeUndefined();
  });

  it('does not expose a rebuild method', () => {
    const driver = createMongoSearchDriver(makeCtx());
    expect(driver.rebuild).toBeUndefined();
  });

  it('returns no hits for an empty query', async () => {
    await seedPage({ path: '/alpha', body: 'hello world' });
    const driver = createMongoSearchDriver(makeCtx());
    const res = await driver.query({ q: '   ' });
    expect(res.total).toBe(0);
    expect(res.hits).toEqual([]);
  });

  it('matches by path (title) and by body', async () => {
    await seedPage({ path: '/planning/roadmap', body: 'no match in body' });
    await seedPage({ path: '/other', body: 'this mentions planning inside the body' });
    const driver = createMongoSearchDriver(makeCtx());
    const res = await driver.query({ q: 'planning' });
    const paths = res.hits.map((h) => h.path).sort();
    expect(paths).toEqual(['/other', '/planning/roadmap']);
    expect(res.total).toBe(2);
  });

  it('ranks path hits ahead of body-only hits', async () => {
    await seedPage({ path: '/body-only', body: 'the term apple appears here' });
    await seedPage({ path: '/apple-pie', body: 'unrelated' });
    const driver = createMongoSearchDriver(makeCtx());
    const res = await driver.query({ q: 'apple' });
    expect(res.hits[0].path).toBe('/apple-pie');
    expect(res.hits[0].score).toBe(2);
    expect(res.hits[1].path).toBe('/body-only');
    expect(res.hits[1].score).toBe(1);
  });

  it('is case-insensitive', async () => {
    await seedPage({ path: '/Foo', body: 'BarBaz' });
    const driver = createMongoSearchDriver(makeCtx());
    const res = await driver.query({ q: 'barbaz' });
    expect(res.total).toBe(1);
  });

  it('excludes drafts, deleted pages and redirects', async () => {
    await seedPage({ path: '/secret-draft', body: 'topsecret', status: 'draft' });
    await seedPage({ path: '/gone', body: 'topsecret', status: 'deleted' });
    await seedPage({ path: '/redir', body: 'topsecret', redirectTo: '/elsewhere' });
    await seedPage({ path: '/live', body: 'topsecret' });
    const driver = createMongoSearchDriver(makeCtx());
    const res = await driver.query({ q: 'topsecret' });
    expect(res.hits.map((h) => h.path)).toEqual(['/live']);
  });

  describe('grant-aware filtering', () => {
    const owner = new Types.ObjectId();
    const viewer = new Types.ObjectId();

    beforeEach(async () => {
      await seedPage({ path: '/public-secret', body: 'secret', grant: 1 });
      await seedPage({ path: '/owner-secret', body: 'secret', grant: 4, creator: owner, grantedUsers: [owner] });
      await seedPage({ path: '/shared-secret', body: 'secret', grant: 3, creator: owner, grantedUsers: [owner, viewer] });
    });

    it('anonymous viewer sees public pages only', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const res = await driver.query({ q: 'secret' });
      expect(res.hits.map((h) => h.path)).toEqual(['/public-secret']);
    });

    it('non-admin viewer sees public + pages shared with them', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const q: SearchQuery = { q: 'secret', viewer: { id: viewer.toString(), username: 'viewer' } };
      const res = await driver.query(q);
      expect(res.hits.map((h) => h.path).sort()).toEqual(['/public-secret', '/shared-secret']);
    });

    it('owner sees their own owner-only page', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const q: SearchQuery = { q: 'secret', viewer: { id: owner.toString(), username: 'owner' } };
      const res = await driver.query(q);
      expect(res.hits.map((h) => h.path).sort()).toEqual(['/owner-secret', '/public-secret', '/shared-secret']);
    });

    it('admin sees everything', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const q: SearchQuery = { q: 'secret', viewer: { id: new Types.ObjectId().toString(), username: 'root', isAdmin: true } };
      const res = await driver.query(q);
      expect(res.total).toBe(3);
    });
  });

  describe('pageType / pathPrefix filters', () => {
    beforeEach(async () => {
      await seedPage({ path: '/docs/', body: 'topic' });
      await seedPage({ path: '/docs/intro', body: 'topic' });
      await seedPage({ path: '/user/alice/topic', body: 'topic' });
    });

    it('portal type returns directory pages only (excludes /user/)', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const res = await driver.query({ q: 'topic', grants: { types: ['portal'] } });
      expect(res.hits.map((h) => h.path)).toEqual(['/docs/']);
    });

    it('user type returns /user/ pages only', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const res = await driver.query({ q: 'topic', grants: { types: ['user'] } });
      expect(res.hits.map((h) => h.path)).toEqual(['/user/alice/topic']);
    });

    it('pathPrefix narrows to a subtree (portal page included, /user/ outside the tree excluded)', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const res = await driver.query({ q: 'topic', pathPrefix: '/docs/' });
      // Mirrors the ES driver's `wildcard: <prefix>/*`: the subtree includes
      // the portal page itself and its descendants, but nothing outside it.
      expect(res.hits.map((h) => h.path).sort()).toEqual(['/docs/', '/docs/intro']);
    });
  });

  describe('paging', () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i++) {
        await seedPage({ path: `/page-pg-${i}`, body: 'body' });
      }
    });

    it('respects page + limit', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const first = await driver.query({ q: 'pg', page: 1, limit: 2 });
      const second = await driver.query({ q: 'pg', page: 2, limit: 2 });
      expect(first.total).toBe(5);
      expect(first.hits).toHaveLength(2);
      expect(second.hits).toHaveLength(2);
      const firstIds = new Set(first.hits.map((h) => h.id));
      expect(second.hits.every((h) => !firstIds.has(h.id))).toBe(true);
    });

    it('caps limit at 200', async () => {
      const driver = createMongoSearchDriver(makeCtx());
      const res = await driver.query({ q: 'pg', limit: 9999 });
      // Only 5 pages exist; the cap doesn't reduce results here but the
      // request must not throw and returns all of them.
      expect(res.total).toBe(5);
      expect(res.hits).toHaveLength(5);
    });
  });
});
