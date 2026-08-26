import type { SearchDriver, SearchableDoc } from '@crowi/plugin-api';
import { crowi } from 'src/test/setup';
import { createTestUser, createPageViaApi } from 'src/test/test-helpers';
import { indexPageInSearch, indexPageInSearchById } from './page-search-index';

/**
 * feature-restricted-grant-share-banner Phase 1 — unit tests for
 * `indexPageInSearchById` (fresh-reread reindex-by-id, shared by the claim
 * handler / `setPageGrant` / `deletePage`'s soft-delete branch) and the
 * `wip` / `deprecated` index-side status exclusion added to
 * `indexPageInSearch` (§"index 側の status 境界の整合").
 */

interface MockSearchDriver extends SearchDriver {
  indexed: SearchableDoc[];
  removed: string[];
  indexImpl?: (doc: SearchableDoc) => Promise<void>;
  removeImpl?: (id: string) => Promise<void>;
}

const buildMockDriver = (): MockSearchDriver => {
  const driver: MockSearchDriver = {
    indexed: [],
    removed: [],
    async index(doc: SearchableDoc) {
      if (driver.indexImpl) return driver.indexImpl(doc);
      driver.indexed.push(doc);
    },
    async remove(id: string) {
      if (driver.removeImpl) return driver.removeImpl(id);
      driver.removed.push(id);
    },
    async query() {
      return { total: 0, hits: [] };
    },
  };
  return driver;
};

/** Mirrors `search.test.ts`'s local helper — duplicated, not shared. */
const withMockDriver = async (driver: SearchDriver | null, fn: () => Promise<void>) => {
  if (!crowi.pluginRegistries) {
    throw new Error('pluginRegistries not initialized — Crowi.init() must run first');
  }
  const original = crowi.pluginRegistries.active.search;
  crowi.pluginRegistries.active.search = driver;
  try {
    await fn();
  } finally {
    crowi.pluginRegistries.active.search = original;
  }
};

describe('indexPageInSearchById', () => {
  const PATH_PREFIX = '/hono-page-search-index-test/';
  let accessToken: string;
  let userId: string;

  beforeAll(async () => {
    const seeded = await createTestUser({
      name: 'Page Search Index Tester',
      username: 'pageSearchIndexTester',
      email: 'page-search-index-tester@example.com',
    });
    accessToken = seeded.accessToken;
    userId = seeded.user._id.toString();
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
  });

  it('no-ops when no search driver is registered', async () => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}no-driver`, '# body');
    await withMockDriver(null, async () => {
      await expect(indexPageInSearchById(crowi, page._id)).resolves.toBeUndefined();
    });
  });

  it('indexes the FRESH DB state (grantedUsers as of the read, not a stale in-memory snapshot)', async () => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}fresh`, '# body');
    const driver = buildMockDriver();

    await withMockDriver(driver, async () => {
      await indexPageInSearchById(crowi, page._id);
    });

    expect(driver.indexed).toHaveLength(1);
    expect(driver.indexed[0]?.id).toBe(page._id);
    // `Page.createPage` always seeds `grantedUsers: [creator]` regardless
    // of grant (models/page.ts) — this asserts the reindex reflects the
    // FRESH DB array, not an assumption about its (non-empty) contents.
    expect(driver.indexed[0]?.meta?.granted_users).toEqual([userId]);
  });

  it('removes from the index when the fresh read finds no document', async () => {
    const driver = buildMockDriver();
    await withMockDriver(driver, async () => {
      await indexPageInSearchById(crowi, '0123456789abcdef01234567');
    });
    expect(driver.removed).toEqual(['0123456789abcdef01234567']);
  });

  it('swallows a refetch error instead of rejecting (no unhandledRejection risk)', async () => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}refetch-throws`, '# body');
    const Page = crowi.model('Page');
    const spy = jest.spyOn(Page, 'findById').mockImplementationOnce(() => {
      throw new Error('mongo blip');
    });
    const driver = buildMockDriver();

    try {
      await withMockDriver(driver, async () => {
        await expect(indexPageInSearchById(crowi, page._id)).resolves.toBeUndefined();
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('swallows a searcher.remove error in the "document already gone" branch (outside indexPageInSearch\'s own try/catch)', async () => {
    const driver = buildMockDriver();
    driver.removeImpl = async () => {
      throw new Error('search cluster down');
    };

    await withMockDriver(driver, async () => {
      await expect(indexPageInSearchById(crowi, '0123456789abcdef01234567')).resolves.toBeUndefined();
    });
  });

  it('swallows a searcher.index error (delegated to indexPageInSearch, which already swallows internally)', async () => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}index-throws`, '# body');
    const driver = buildMockDriver();
    driver.indexImpl = async () => {
      throw new Error('search cluster down');
    };

    await withMockDriver(driver, async () => {
      await expect(indexPageInSearchById(crowi, page._id)).resolves.toBeUndefined();
    });
  });
});

describe('indexPageInSearch — index-side status exclusion (feature-restricted-grant-share-banner §"index 側の status 境界の整合")', () => {
  const PATH_PREFIX = '/hono-page-search-index-status-test/';
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await createTestUser({
      name: 'Page Search Index Status Tester',
      username: 'pageSearchIndexStatusTester',
      email: 'page-search-index-status-tester@example.com',
    }));
  });

  afterEach(async () => {
    const Page = crowi.model('Page');
    await Page.deleteMany({ path: { $regex: `^${PATH_PREFIX}` } });
  });

  it.each(['wip', 'deprecated'] as const)('removes (does not index) a %s page', async (status) => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}${status}`, '# body');
    const Page = crowi.model('Page');
    const doc = await Page.findById(page._id).populate('revision').populate('creator');
    doc.status = status;

    const driver = buildMockDriver();
    await withMockDriver(driver, async () => {
      await indexPageInSearch(crowi, doc);
    });

    expect(driver.indexed).toHaveLength(0);
    expect(driver.removed).toContain(page._id);
  });

  it('drops a page mid-transition from the index and puts it back once it settles (RFC-0021 AC-15)', async () => {
    // A page between the entering and leaving CAS of a path move would
    // otherwise be indexed under a path it may not keep. Because the exclusion
    // drives a `remove` rather than a skip, entering drops it and settling
    // re-indexes it — no separate bookkeeping.
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}renaming`, '# body');
    const Page = crowi.model('Page');
    const doc = await Page.findById(page._id).populate('revision').populate('creator');

    const driver = buildMockDriver();
    await withMockDriver(driver, async () => {
      doc.status = 'renaming';
      await indexPageInSearch(crowi, doc);
      expect(driver.indexed).toHaveLength(0);
      expect(driver.removed).toContain(page._id);

      doc.status = 'published';
      await indexPageInSearch(crowi, doc);
    });

    expect(driver.indexed).toHaveLength(1);
    expect(driver.indexed[0]?.id).toBe(page._id);
  });

  it('re-indexes a page once its status returns to published', async () => {
    const page = await createPageViaApi(accessToken, `${PATH_PREFIX}republish`, '# body');
    const Page = crowi.model('Page');
    const doc = await Page.findById(page._id).populate('revision').populate('creator');

    const driver = buildMockDriver();
    await withMockDriver(driver, async () => {
      doc.status = 'wip';
      await indexPageInSearch(crowi, doc);
      expect(driver.indexed).toHaveLength(0);

      doc.status = 'published';
      await indexPageInSearch(crowi, doc);
    });

    expect(driver.indexed).toHaveLength(1);
    expect(driver.indexed[0]?.id).toBe(page._id);
  });
});
