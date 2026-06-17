import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { MigrationDb } from '../types';

import { MigrationRunner } from '../runner';
import { relocateReservedApiPaths, relocatedApiPath } from './relocate-reserved-api-paths';

/**
 * `relocate-reserved-api-paths` preflight migration (v1 → v2.0).
 *
 * Covers:
 *   - pages under the reserved `/api` namespace (bare `/api`, nested, and
 *     `/api/v2/*`) move to `/api-legacy/*`, with their revisions following
 *   - paths that merely start with `api` (`/apiary`) and unrelated pages are
 *     left untouched
 *   - a pre-existing relocation target is avoided with a `-N` suffix
 *   - `isPending` is true while `/api/*` pages exist and flips false after
 *     apply (no permanent boot block)
 */

const db = (): MigrationDb => crowi.getMongo().connection.db as MigrationDb;
const oid = () => new Types.ObjectId();

const runner = () => new MigrationRunner(crowi, { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });

const clean = async () => {
  const d = db();
  for (const c of ['pages', 'revisions']) {
    await d.collection(c).deleteMany({ migtest: true });
  }
};

/** Insert a page + its single revision at `path`, both tagged `migtest`. */
const seedPage = async (path: string): Promise<Types.ObjectId> => {
  const d = db();
  const pageId = oid();
  const revId = oid();
  await d.collection('pages').insertOne({ _id: pageId, migtest: true, path, revision: revId });
  await d.collection('revisions').insertOne({ _id: revId, migtest: true, path, body: `# ${path}` });
  return pageId;
};

const pathOf = async (pageId: Types.ObjectId): Promise<string> => {
  const doc = (await db().collection('pages').findOne({ _id: pageId })) as { path: string } | null;
  return doc?.path ?? '<missing>';
};

describe('migration/relocate-reserved-api-paths', () => {
  beforeEach(clean);
  afterEach(clean);

  it('is registered as a preflight v1 → 2.0 migration', () => {
    expect(relocateReservedApiPaths.layer).toBe('preflight');
    expect(relocateReservedApiPaths.id).toBe('relocate-reserved-api-paths');
    expect(relocateReservedApiPaths.fromVersion).toBe('1.x');
    expect(relocateReservedApiPaths.toVersion).toBe('2.0');
    expect(relocateReservedApiPaths.stages.map((s) => s.name)).toEqual(['relocate-api-pages']);
  });

  it('maps reserved paths to the /api-legacy root (segment-bounded)', () => {
    expect(relocatedApiPath('/api')).toBe('/api-legacy');
    expect(relocatedApiPath('/api/')).toBe('/api-legacy/');
    expect(relocatedApiPath('/api/docs')).toBe('/api-legacy/docs');
    expect(relocatedApiPath('/api/v2/notes')).toBe('/api-legacy/v2/notes');
  });

  it('relocates pages under /api and follows the move on their revisions', async () => {
    const bare = await seedPage('/api');
    const nested = await seedPage('/api/docs');
    const proxied = await seedPage('/api/v2/notes');
    const apiary = await seedPage('/apiary'); // not reserved — must stay
    const other = await seedPage('/crowi/api'); // `api` not at the top — must stay

    await runner().apply(relocateReservedApiPaths);

    expect(await pathOf(bare)).toBe('/api-legacy');
    expect(await pathOf(nested)).toBe('/api-legacy/docs');
    expect(await pathOf(proxied)).toBe('/api-legacy/v2/notes');
    expect(await pathOf(apiary)).toBe('/apiary');
    expect(await pathOf(other)).toBe('/crowi/api');

    // The relocated page's revision path moved too.
    const rev = (await db().collection('revisions').findOne({ migtest: true, body: '# /api/docs' })) as { path: string } | null;
    expect(rev?.path).toBe('/api-legacy/docs');
  });

  it('avoids a pre-existing relocation target with a -N suffix', async () => {
    const source = await seedPage('/api/docs');
    await seedPage('/api-legacy/docs'); // target already taken

    await runner().apply(relocateReservedApiPaths);

    expect(await pathOf(source)).toBe('/api-legacy/docs-1');
  });

  it('isPending is true with /api pages and flips false after apply', async () => {
    await seedPage('/api/docs');
    expect(await runner().isPending(relocateReservedApiPaths)).toBe(true);

    await runner().apply(relocateReservedApiPaths);
    expect(await runner().isPending(relocateReservedApiPaths)).toBe(false);
  });

  it('isPending is false when no page lives under /api', async () => {
    await seedPage('/apiary');
    await seedPage('/crowi/api');
    expect(await runner().isPending(relocateReservedApiPaths)).toBe(false);
  });
});
