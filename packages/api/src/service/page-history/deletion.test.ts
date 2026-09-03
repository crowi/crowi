import fs from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import ts from 'typescript';

import type { BacklinkModel } from 'src/models/backlink';
import type { PageDeletionRecordModel } from 'src/models/page-deletion-record';
import type { PageHistoryEventModel } from 'src/models/page-history-event';
import type { PageDocument, PageModel } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import type { WatcherModel } from 'src/models/watcher';
import { crowi, Fixture } from 'src/test/setup';
import { deletePageWithMode, PageCleanupIncompleteError, type PageDeletionMode } from './deletion';
import { readPageHistory } from './read';

const NON_RECORDING_MODES = ['creation_cancel', 'redirect_stub_cleanup', 'internal_cleanup'] as const satisfies readonly PageDeletionMode[];

const API_SOURCE_ROOT = path.resolve(__dirname, '../..');
const ALLOWED_PAGE_DELETION_SITE = 'service/page-history/deletion.ts';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const PAGE_DELETION_METHODS = new Set(['deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'findOneAndRemove', 'findByIdAndRemove']);

interface PageDeletionCall {
  file: string;
  line: number;
  expression: string;
}

function isTestSource(relativePath: string): boolean {
  // Tests intentionally bypass the service for fixture setup and fault simulation.
  return relativePath.split('/').includes('test') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

function listProductionSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionSourceFiles(fullPath));
      continue;
    }

    const relativePath = path.relative(API_SOURCE_ROOT, fullPath).split(path.sep).join('/');
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts') && !isTestSource(relativePath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function staticPropertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function propertyReceiver(expression: ts.Expression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return expression.expression;
  return undefined;
}

function isPageModelFactory(expression: ts.Expression): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression) || staticPropertyName(expression.expression) !== 'model') return false;
  const modelName = expression.arguments[0];
  return modelName !== undefined && ts.isStringLiteralLike(modelName) && modelName.text === 'Page';
}

function findPageDeletionCalls(filePath: string): PageDeletionCall[] {
  const relativePath = path.relative(API_SOURCE_ROOT, filePath).split(path.sep).join('/');
  const sourceFile = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const pageModelIdentifiers = new Set(['Page']);
  const calls: PageDeletionCall[] = [];

  const collectPageModelIdentifiers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isPageModelFactory(node.initializer)) {
      pageModelIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collectPageModelIdentifiers);
  };
  collectPageModelIdentifiers(sourceFile);

  const isPageReceiver = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) return pageModelIdentifiers.has(expression.text) || expression.text === 'page';
    if (isPageModelFactory(expression)) return true;
    return staticPropertyName(expression) === 'collection' && propertyReceiver(expression) !== undefined && isPageReceiver(propertyReceiver(expression));
  };

  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = staticPropertyName(node.expression);
      const receiver = propertyReceiver(node.expression);
      if (method !== undefined && receiver !== undefined && PAGE_DELETION_METHODS.has(method) && isPageReceiver(receiver)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        calls.push({ file: relativePath, line: line + 1, expression: node.expression.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(sourceFile);

  return calls;
}

describe('service/page-history/deletion', () => {
  let Page: PageModel;
  let PageDeletionRecord: PageDeletionRecordModel;
  let PageHistoryEvent: PageHistoryEventModel;
  let Watcher: WatcherModel;
  let Backlink: BacklinkModel;
  let user: UserDocument;

  beforeAll(async () => {
    Page = crowi.model('Page');
    PageDeletionRecord = crowi.model('PageDeletionRecord');
    PageHistoryEvent = crowi.model('PageHistoryEvent');
    Watcher = crowi.model('Watcher');
    Backlink = crowi.model('Backlink');
    [user] = await Fixture.generate('User', [{ name: 'Deletion Tester', username: 'deletion-tester', email: 'deletion-tester@example.com' }]);
  });

  beforeEach(async () => {
    await PageDeletionRecord.deleteMany({});
  });

  describe('PageDeletionRecord schema', () => {
    test('keeps pageId as a recorded value without a Page reference', () => {
      expect(PageDeletionRecord.schema.path('pageId').options.ref).toBeUndefined();
    });

    test('defines the three lookup indexes without a TTL index', () => {
      const indexes = PageDeletionRecord.schema.indexes();

      expect(indexes.map(([keys]) => keys)).toEqual(expect.arrayContaining([{ path: 1, deletedAt: -1 }, { deletedAt: -1 }, { pageId: 1 }]));
      expect(indexes).toHaveLength(3);
      expect(indexes.every(([, options]) => options.expireAfterSeconds === undefined)).toBe(true);
    });
  });

  describe('deletePageWithMode', () => {
    const createHistoryEvent = (page: PageDocument) =>
      PageHistoryEvent.create({
        page: page._id,
        sequence: 1,
        kind: 'visibility_changed',
        actor: user._id,
        occurredAt: new Date(),
        operationId: `delete-${page._id}`,
        source: 'web',
        payload: { fromGrant: 1, toGrant: 4 },
      });

    test('user_hard_delete writes only the deletion metadata and purges the page-scoped history', async () => {
      const page = await Page.createPage('/deletion-record/hard-delete', 'private body', user, {});
      await createHistoryEvent(page);
      const earliestDeletedAt = new Date();

      await deletePageWithMode(crowi, {
        pageId: page._id,
        path: page.path,
        actor: user._id,
        mode: 'user_hard_delete',
      });

      const record = await PageDeletionRecord.collection.findOne({ pageId: page._id });
      expect(record).not.toBeNull();
      expect(record).toMatchObject({ pageId: page._id, path: page.path, actor: user._id, mode: 'user_hard_delete' });
      expect(record?.deletedAt).toBeInstanceOf(Date);
      expect(record?.deletedAt.getTime()).toBeGreaterThanOrEqual(earliestDeletedAt.getTime());
      expect(Object.keys(record ?? {}).sort()).toEqual(['_id', 'actor', 'deletedAt', 'mode', 'pageId', 'path'].sort());
      expect(await Page.findById(page._id)).toBeNull();
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    test('does not surface the admin-only deletion record through the page history timeline', async () => {
      const page = await Page.createPage('/deletion-record/not-page-history', 'body', user, {});

      await deletePageWithMode(crowi, {
        pageId: page._id,
        path: page.path,
        actor: user._id,
        mode: 'user_hard_delete',
      });

      expect(await PageDeletionRecord.countDocuments({ pageId: page._id })).toBe(1);
      expect(await readPageHistory(crowi, { pageId: page._id, limit: 20, cursor: null })).toEqual({
        entries: [],
        nextCursor: null,
        tracking: { state: 'untracked' },
      });
    });

    test('does not attempt to delete the Page until the deletion record write resolves', async () => {
      const page = await Page.createPage('/deletion-record/order', 'body', user, {});
      const originalCreate = PageDeletionRecord.create.bind(PageDeletionRecord);
      let resolveRecordWrite: (() => void) | undefined;
      const recordWriteGate = new Promise<void>((resolve) => {
        resolveRecordWrite = resolve;
      });
      const recordSpy = jest.spyOn(PageDeletionRecord, 'create').mockImplementationOnce((...args) => recordWriteGate.then(() => originalCreate(...args)));
      const deleteSpy = jest.spyOn(Page, 'deleteOne');

      try {
        const deletion = deletePageWithMode(crowi, {
          pageId: page._id,
          path: page.path,
          actor: user._id,
          mode: 'user_hard_delete',
        });

        await Promise.resolve();
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).not.toHaveBeenCalled();

        resolveRecordWrite?.();
        await deletion;

        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0]?.[0]).toMatchObject({ pageId: page._id, path: page.path, actor: user._id, mode: 'user_hard_delete' });
      } finally {
        resolveRecordWrite?.();
        recordSpy.mockRestore();
        deleteSpy.mockRestore();
      }
    });

    test('keeps the record and the Page when Page deletion fails after the record write', async () => {
      const page = await Page.createPage('/deletion-record/delete-fails', 'body', user, {});
      const deleteSpy = jest.spyOn(Page, 'deleteOne').mockRejectedValueOnce(new Error('delete failed'));

      try {
        await expect(
          deletePageWithMode(crowi, {
            pageId: page._id,
            path: page.path,
            actor: user._id,
            mode: 'user_hard_delete',
          }),
        ).rejects.toThrow('delete failed');
      } finally {
        deleteSpy.mockRestore();
      }

      expect(await PageDeletionRecord.countDocuments({ pageId: page._id })).toBe(1);
      expect(await Page.findById(page._id)).not.toBeNull();
    });

    test.each(NON_RECORDING_MODES)('%s deletes the Page and purges history without writing a deletion record', async (mode) => {
      const page = await Page.createPage(`/deletion-record/${mode}`, 'body', user, {});
      await createHistoryEvent(page);

      await deletePageWithMode(crowi, {
        pageId: page._id,
        path: page.path,
        actor: user._id,
        mode,
      });

      expect(await PageDeletionRecord.countDocuments({ pageId: page._id })).toBe(0);
      expect(await Page.findById(page._id)).toBeNull();
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    // Seeds a WATCH row, an IGNORE row, and one inbound + one outbound
    // Backlink row for `page`, so a single `deletePageWithMode` call can be
    // asserted against all four relation rows at once.
    const seedRelationFixtures = async (page: PageDocument) => {
      // The create above schedules an async auto-watch write for `user` on
      // `page` (and a Backlink rebuild). `upsertWatcher` is a
      // `findOneAndUpdate` upsert with no unique index backing it, so a
      // late auto-watch write racing this fixture's own WATCH upsert for
      // the SAME (user, 'Page', page._id) triple can insert a second row
      // instead of updating the existing one — draining first prevents that.
      await crowi.drainSideEffects();
      const otherUserId = new Types.ObjectId();
      await Watcher.upsertWatcher(user._id, 'Page', page._id, Watcher.STATUS_WATCH);
      await Watcher.upsertWatcher(otherUserId, 'Page', page._id, Watcher.STATUS_IGNORE);
      await Backlink.create({ page: page._id, fromPage: new Types.ObjectId(), fromRevision: new Types.ObjectId() }); // inbound
      await Backlink.create({ page: new Types.ObjectId(), fromPage: page._id, fromRevision: new Types.ObjectId() }); // outbound
    };

    test("deletePageWithMode deletes the target page's WATCH/IGNORE and inbound/outbound Backlink rows as part of its post-delete best-effort cleanup, alongside existing revisions/history-events cleanup", async () => {
      const page = await Page.createPage('/deletion-record/relation-cleanup', 'body', user, {});
      await createHistoryEvent(page);
      await seedRelationFixtures(page);

      await deletePageWithMode(crowi, {
        pageId: page._id,
        path: page.path,
        actor: user._id,
        mode: 'internal_cleanup',
      });

      expect(await Page.findById(page._id)).toBeNull();
      expect(await Watcher.countDocuments({ targetModel: 'Page', target: page._id })).toBe(0);
      expect(await Backlink.countDocuments({ $or: [{ page: page._id }, { fromPage: page._id }] })).toBe(0);
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    test('deletePageWithMode deletes the Page and still runs watchers, revisions, and history-events without throwing when only the backlinks relation cleanup rejects', async () => {
      const page = await Page.createPage('/deletion-record/backlinks-reject', 'body', user, {});
      await createHistoryEvent(page);
      await seedRelationFixtures(page);

      const backlinkSpy = jest.spyOn(Backlink, 'removeByPageIdForHardDelete').mockRejectedValueOnce(new Error('MARKER_BACKLINK_CLEANUP_FAILURE'));

      try {
        await expect(
          deletePageWithMode(crowi, {
            pageId: page._id,
            path: page.path,
            actor: user._id,
            mode: 'internal_cleanup',
          }),
        ).resolves.toBeUndefined();
      } finally {
        backlinkSpy.mockRestore();
      }

      expect(await Page.findById(page._id)).toBeNull();
      // watchers step still ran despite the backlinks rejection.
      expect(await Watcher.countDocuments({ targetModel: 'Page', target: page._id })).toBe(0);
      // The rejected step leaves its rows as orphans (best-effort, D-1).
      expect(await Backlink.countDocuments({ $or: [{ page: page._id }, { fromPage: page._id }] })).toBe(2);
      // revisions / history-events aggregation is unaffected — no error surfaces.
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    test('deletePageWithMode deletes the Page and still runs backlinks, revisions, and history-events without throwing when only the watchers relation cleanup rejects', async () => {
      const page = await Page.createPage('/deletion-record/watchers-reject', 'body', user, {});
      await createHistoryEvent(page);
      await seedRelationFixtures(page);

      const watcherSpy = jest.spyOn(Watcher, 'removeByPageId').mockRejectedValueOnce(new Error('MARKER_WATCHER_CLEANUP_FAILURE'));

      try {
        await expect(
          deletePageWithMode(crowi, {
            pageId: page._id,
            path: page.path,
            actor: user._id,
            mode: 'internal_cleanup',
          }),
        ).resolves.toBeUndefined();
      } finally {
        watcherSpy.mockRestore();
      }

      expect(await Page.findById(page._id)).toBeNull();
      // backlinks step still ran despite the watchers rejection.
      expect(await Backlink.countDocuments({ $or: [{ page: page._id }, { fromPage: page._id }] })).toBe(0);
      // The rejected step leaves its rows as orphans (best-effort, D-1).
      expect(await Watcher.countDocuments({ targetModel: 'Page', target: page._id })).toBe(2);
      // revisions / history-events aggregation is unaffected — no error surfaces.
      expect(await PageHistoryEvent.countDocuments({ page: page._id })).toBe(0);
    });

    test('backlinks/watchers rejections never appear in PageCleanupIncompleteError.steps, even when revisions/history-events also fail', async () => {
      const page = await Page.createPage('/deletion-record/relation-and-history-reject', 'body', user, {});
      await createHistoryEvent(page);
      await seedRelationFixtures(page);

      const backlinkSpy = jest.spyOn(Backlink, 'removeByPageIdForHardDelete').mockRejectedValueOnce(new Error('MARKER_BACKLINK_CLEANUP_FAILURE'));
      const watcherSpy = jest.spyOn(Watcher, 'removeByPageId').mockRejectedValueOnce(new Error('MARKER_WATCHER_CLEANUP_FAILURE'));
      const historyEventSpy = jest.spyOn(PageHistoryEvent, 'deleteMany').mockImplementationOnce(
        () =>
          ({
            exec: () => Promise.reject(new Error('MARKER_HISTORY_EVENT_FAILURE')),
          }) as unknown as ReturnType<typeof PageHistoryEvent.deleteMany>,
      );

      try {
        const error = await deletePageWithMode(crowi, {
          pageId: page._id,
          path: page.path,
          actor: user._id,
          mode: 'internal_cleanup',
        }).catch((err) => err);

        expect(error).toBeInstanceOf(PageCleanupIncompleteError);
        expect((error as PageCleanupIncompleteError).steps).toEqual(['history-events']);
      } finally {
        backlinkSpy.mockRestore();
        watcherSpy.mockRestore();
        historyEventSpy.mockRestore();
      }

      expect(await Page.findById(page._id)).toBeNull();
    });
  });

  describe('Page deletion path', () => {
    test('excludes test sources but permits exactly one Page deletion call in the named deletion service', () => {
      const calls = listProductionSourceFiles(API_SOURCE_ROOT).flatMap(findPageDeletionCalls);

      expect(calls).toEqual([
        {
          file: ALLOWED_PAGE_DELETION_SITE,
          line: expect.any(Number),
          expression: 'Page.deleteOne',
        },
      ]);
    });

    test('completelyDeletePage forwards the user hard-delete mode and actor to the deletion service', async () => {
      const page = await Page.createPage('/deletion-record/model-path', 'body', user, {});

      await Page.completelyDeletePage(page, user, {
        deletion: { mode: 'user_hard_delete', actor: user._id },
      });

      expect(await PageDeletionRecord.countDocuments({ pageId: page._id, actor: user._id, mode: 'user_hard_delete' })).toBe(1);
    });
  });
});
