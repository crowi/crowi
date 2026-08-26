import { STATUS_DELETED, STATUS_PUBLISHED } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { crowi } from 'src/test/setup';

/**
 * RFC-0017 Phase 1 §D1/§D7/§D8/§D9/§D10 — the `Page` model lifecycle
 * contract: every mutation that durably changes `path`/`status`/removes a
 * row advances `collabLifecycleVersion` in the SAME `updateOne`, and the
 * typed emit/skip invalidation option controls ONLY the best-effort
 * `crowi:force-reload` prompt.
 *
 * Uses the `page-external-edit.test.ts` stub pattern: `crowi.collabAttachment
 * = { invalidatePages: jest.fn(), shutdown: async () => undefined }` +
 * `toHaveBeenCalledWith([pageId], reason)`.
 *
 * Covers AC-20..33.
 */
const seedUser = (suffix: string) =>
  new Promise<UserDocument>((resolve, reject) => {
    const User = crowi.model('User');
    User.createUserByEmailAndPassword(
      `Epoch ${suffix}`,
      `epoch-${suffix}`,
      `epoch-${suffix}@example.com`,
      'password123',
      'en',
      async (err: Error | null, user: UserDocument) => {
        if (err) return reject(err);
        user.status = User.STATUS_ACTIVE;
        await user.save();
        resolve(user);
      },
    );
  });

describe('Page lifecycle — RFC-0017 Phase 1 collabLifecycleVersion contract', () => {
  const Page = () => crowi.model('Page');
  const PageYjsUpdate = () => crowi.model('PageYjsUpdate');

  const withInvalidateSpy = async (fn: (invalidatePages: jest.Mock) => Promise<void>) => {
    const invalidatePages = jest.fn(async () => undefined);
    const previous = crowi.collabAttachment;
    crowi.collabAttachment = { invalidatePages, shutdown: async () => undefined };
    try {
      await fn(invalidatePages);
    } finally {
      crowi.collabAttachment = previous;
    }
  };

  test('AC-20/AC-30: Page.rename advances the epoch in the SAME updateOne as the path write, and emits page-renamed right after (default createRedirectPage:true early-return case)', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('rename-a');
      const page = await Page().createPage('/epoch-rename-a', 'body', user, {});
      expect(page.collabLifecycleVersion).toBe(0);

      const renamed = await Page().rename(page, '/epoch-rename-a-renamed', user, { createRedirectPage: true });
      // `createRedirectPage: true` early-returns via `Page.createPage` for
      // the redirect stub — `renamed` is THAT stub, not the moved page. Read
      // the moved page back to assert its epoch.
      const moved = await Page().findById(page._id).exec();
      expect(moved.path).toBe('/epoch-rename-a-renamed');
      expect(moved.collabLifecycleVersion).toBe(1);
      await Promise.resolve();
      expect(invalidatePages).toHaveBeenCalledWith([page._id.toString()], 'page-renamed');
      expect(renamed).toBeTruthy();
    });
  });

  test('AC-30: page-renamed still emits even when the follow-up Revision.updateRevisionListByPath throws', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('rename-revision-throw');
      const page = await Page().createPage('/epoch-rename-revision-throw', 'body', user, {});
      const Revision = crowi.model('Revision');
      const spy = jest.spyOn(Revision, 'updateRevisionListByPath').mockImplementationOnce(async () => {
        throw new Error('simulated revision-path rewrite failure');
      });

      try {
        await expect(Page().rename(page, '/epoch-rename-revision-throw-2', user, { createRedirectPage: false })).rejects.toThrow(
          'simulated revision-path rewrite failure',
        );
      } finally {
        spy.mockRestore();
      }

      // The path write + epoch advance already landed before the throwing
      // follow-up step, and the emit was wired immediately after that write
      // (§D7/AC-30) — so it must have fired despite the later throw.
      const moved = await Page().findById(page._id).exec();
      expect(moved.path).toBe('/epoch-rename-revision-throw-2');
      expect(moved.collabLifecycleVersion).toBe(1);
      await Promise.resolve();
      expect(invalidatePages).toHaveBeenCalledWith([page._id.toString()], 'page-renamed');
    });
  });

  test('AC-22/AC-25: a skip-mode rename suppresses the page-renamed prompt but STILL advances the epoch', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('rename-skip');
      const page = await Page().createPage('/epoch-rename-skip', 'body', user, {});

      await Page().rename(page, '/epoch-rename-skip-2', user, { invalidation: { mode: 'skip', reason: 'internal-repair' } });
      const moved = await Page().findById(page._id).exec();
      expect(moved.collabLifecycleVersion).toBe(1);
      await Promise.resolve();
      expect(invalidatePages).not.toHaveBeenCalled();
    });
  });

  test('AC-23/AC-24: Page.deletePage emits page-deleted + advances epoch + purges collab lineage right after the status write, surviving a later throw', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('delete-a');
      const page = await Page().createPage('/epoch-delete-a', 'body', user, {});
      // Simulate a prior collab checkpoint to prove the purge.
      await Page()
        .updateOne({ _id: page._id }, { $set: { yjsState: Buffer.from([1, 2, 3]), yjsCheckpointAt: new Date() } })
        .exec();
      await PageYjsUpdate().create({ pageId: page._id, payload: Buffer.from([9, 9]), createdAt: new Date() });

      await Page().deletePage(page, user);

      const deleted = await Page()
        .findOne({ path: { $regex: '^/trash/epoch-delete-a' } })
        .exec();
      expect(deleted).toBeTruthy();
      expect(deleted.status).toBe(STATUS_DELETED);
      // Two epoch advances land in the SAME deletePage call: the status
      // write (0->1) AND the internal /trash/ rename (1->2, epoch advance is
      // unconditional per Page.rename regardless of its skip-mode prompt).
      expect(deleted.collabLifecycleVersion).toBe(2);
      expect(deleted.yjsState ?? null).toBeNull();
      expect(deleted.yjsCheckpointAt ?? null).toBeNull();
      expect(await PageYjsUpdate().countDocuments({ pageId: page._id }).exec()).toBe(0);

      await Promise.resolve();
      expect(invalidatePages).toHaveBeenCalledWith([page._id.toString()], 'page-deleted');
      // Only ONE page-deleted emit — the internal /trash/ rename (AC-25)
      // must not ALSO fire a page-renamed.
      expect(invalidatePages.mock.calls.map((c) => c[1])).toEqual(['page-deleted']);
    });
  });

  test('AC-21: a non-deletable page throws BEFORE writing anything — epoch never advances', async () => {
    const user = await seedUser('non-deletable');
    // Activation kicks off a fire-and-forget user-home-page creation
    // (userEvent 'activated' → onActivated → createUserPage). Creating the
    // same path here would race it — E11000 when the hook wins, an
    // epoch-advancing repair rename when it loses. Drain the side effect
    // and assert against the hook-created home page instead.
    await crowi.drainSideEffects();
    // A user home page is never deletable (isDeletableName / USER_HOME_PAGE_PATH).
    const userPagePath = Page().getUserPagePath(user);
    const page = await Page().findPage(userPagePath, user, {}, true);
    expect(page).toBeTruthy();
    expect(page.collabLifecycleVersion).toBe(0);

    await expect(Page().deletePage(page, user)).rejects.toThrow('Page is not deletable.');
    const stillThere = await Page().findById(page._id).exec();
    expect(stillThere.status).not.toBe(STATUS_DELETED);
    expect(stillThere.collabLifecycleVersion).toBe(0);
  });

  test('AC-26: Page.completelyDeletePage emits page-deleted for the typed user-facing hard delete, deletes PageYjsUpdate rows (privacy), and emits even if later cleanup throws', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('hard-delete');
      const page = await Page().createPage('/epoch-hard-delete', 'body', user, {});
      await PageYjsUpdate().create({ pageId: page._id, payload: Buffer.from([1]), createdAt: new Date() });

      await Page().completelyDeletePage(page, user, { deletion: { mode: 'user_hard_delete', actor: user._id } });

      const gone = await Page().findById(page._id).exec();
      expect(gone).toBeNull();
      expect(await PageYjsUpdate().countDocuments({ pageId: page._id }).exec()).toBe(0);
      await Promise.resolve();
      expect(invalidatePages).toHaveBeenCalledWith([page._id.toString()], 'page-deleted');
      expect(invalidatePages).toHaveBeenCalledTimes(1);
    });
  });

  test('AC-26: completelyDeletePage with mode:"skip" (internal revert cleanup) does not emit', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('hard-delete-skip');
      const page = await Page().createPage('/epoch-hard-delete-skip', 'body', user, {});

      await Page().completelyDeletePage(page, user, {
        invalidation: { mode: 'skip', reason: 'revert-deleted' },
        deletion: { mode: 'redirect_stub_cleanup', actor: user._id },
      });
      await Promise.resolve();
      expect(invalidatePages).not.toHaveBeenCalled();
    });
  });

  test('AC-27: draft cancel (Page.removePage with mode:"emit") emits page-deleted and deletes PageYjsUpdate rows (privacy)', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('draft-cancel');
      const page = await Page().createPage('/epoch-draft-cancel', 'body', user, { grant: 1 });
      await PageYjsUpdate().create({ pageId: page._id, payload: Buffer.from([1]), createdAt: new Date() });

      await Page().removePage(page, {
        invalidation: { mode: 'emit', reason: 'page-deleted', target: 'live-page' },
        deletion: { mode: 'creation_cancel', actor: user._id },
      });

      expect(await Page().findById(page._id).exec()).toBeNull();
      expect(await PageYjsUpdate().countDocuments({ pageId: page._id }).exec()).toBe(0);
      await Promise.resolve();
      expect(invalidatePages).toHaveBeenCalledWith([page._id.toString()], 'page-deleted');
    });
  });

  test('AC-27: Page.removePage with explicit internal cleanup does not over-fire', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('remove-default-skip');
      const page = await Page().createPage('/epoch-remove-default-skip', 'body', user, {});

      await Page().removePage(page, { deletion: { mode: 'internal_cleanup', actor: null } });
      await Promise.resolve();
      expect(invalidatePages).not.toHaveBeenCalled();
    });
  });

  test('AC-27: draft-cancel invalidation fires immediately after Page deletion while later cleanup is still pending', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('draft-cancel-order');
      const page = await Page().createPage('/epoch-draft-cancel-order', 'body', user, { grant: 1 });
      const Revision = crowi.model('Revision');
      let resolveCleanup: (() => void) | undefined;
      let markCleanupStarted: (() => void) | undefined;
      const cleanupStarted = new Promise<void>((resolve) => {
        markCleanupStarted = resolve;
      });
      const cleanupGate = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      const revisionSpy = jest.spyOn(Revision, 'removeRevisionsByPageId').mockImplementationOnce(() => {
        markCleanupStarted?.();
        return cleanupGate;
      });

      try {
        const deletion = Page().removePage(page, {
          invalidation: { mode: 'emit', reason: 'page-deleted', target: 'live-page' },
          deletion: { mode: 'creation_cancel', actor: user._id },
        });
        await cleanupStarted;

        expect(await Page().findById(page._id).exec()).toBeNull();
        expect(invalidatePages).toHaveBeenCalledWith([page._id.toString()], 'page-deleted');

        resolveCleanup?.();
        await deletion;
      } finally {
        resolveCleanup?.();
        revisionSpy.mockRestore();
      }
    });
  });

  test('AC-27: draft-cancel invalidation does not fire when Page deletion fails', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('draft-cancel-delete-failure');
      const page = await Page().createPage('/epoch-draft-cancel-delete-failure', 'body', user, { grant: 1 });
      const deleteSpy = jest.spyOn(Page(), 'deleteOne').mockRejectedValueOnce(new Error('delete failed'));

      try {
        await expect(
          Page().removePage(page, {
            invalidation: { mode: 'emit', reason: 'page-deleted', target: 'live-page' },
            deletion: { mode: 'creation_cancel', actor: user._id },
          }),
        ).rejects.toThrow('delete failed');

        await Promise.resolve();
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(await Page().findById(page._id).exec()).not.toBeNull();
      } finally {
        deleteSpy.mockRestore();
      }
    });
  });

  test('AC-28/AC-29: revertDeletedPage uses skip semantics internally, advances the epoch via status flip + rename, and idempotently re-purges the collab lineage', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('revert-a');
      const page = await Page().createPage('/epoch-revert-a', 'body', user, {});
      await Page().deletePage(page, user);
      invalidatePages.mockClear();

      const deletedPage = await Page().findById(page._id).exec();
      // deletePage advances the epoch twice (status write + internal trash rename).
      expect(deletedPage.collabLifecycleVersion).toBe(2);

      // Simulate a stale append that landed mid-drain, AFTER the delete-time
      // purge already ran, to a NOW-deleted _id (AC-29's drain-window case).
      await PageYjsUpdate().create({ pageId: page._id, payload: Buffer.from([7]), createdAt: new Date(), collabLifecycleVersion: 1 });

      await Page().revertDeletedPage(deletedPage, user);

      const reverted = await Page().findById(page._id).exec();
      expect(reverted.path).toBe('/epoch-revert-a');
      expect(reverted.status).toBe(STATUS_PUBLISHED);
      // Two MORE epoch advances on top of the post-delete epoch (2): status
      // flip to published, then the internal restoration rename.
      expect(reverted.collabLifecycleVersion).toBe(4);
      // Re-purge cleared the yjsState/PageYjsUpdate lineage again
      // (idempotent), including the stale-epoch row appended mid-drain.
      expect(reverted.yjsState ?? null).toBeNull();
      expect(await PageYjsUpdate().countDocuments({ pageId: page._id }).exec()).toBe(0);

      await Promise.resolve();
      // No page-renamed / page-deleted emitted for the internal repair steps.
      expect(invalidatePages).not.toHaveBeenCalled();
    });
  });

  test('AC-31/AC-32: Page.renameTree reports successes + failures and per-descendant epoch-advances + emits (subtree rename)', async () => {
    await withInvalidateSpy(async (invalidatePages) => {
      const user = await seedUser('tree-a');
      const root = await Page().createPage('/epoch-tree-a', 'root body', user, {});
      const child = await Page().createPage('/epoch-tree-a/child', 'child body', user, {});

      const pathMap = { '/epoch-tree-a': '/epoch-tree-b', '/epoch-tree-a/child': '/epoch-tree-b/child' };
      const result = await Page().renameTree(pathMap, user, { createRedirectPage: false, preserveUpdatedAt: true });

      expect(result.failures).toEqual([]);
      expect(result.successes).toHaveLength(2);

      const movedRoot = await Page().findOne({ path: '/epoch-tree-b' }).exec();
      const movedChild = await Page().findOne({ path: '/epoch-tree-b/child' }).exec();
      expect(movedRoot.collabLifecycleVersion).toBe(1);
      expect(movedChild.collabLifecycleVersion).toBe(1);

      await Promise.resolve();
      // Both root AND child got their OWN page-renamed emit — not just the root.
      expect(invalidatePages).toHaveBeenCalledWith([root._id.toString()], 'page-renamed');
      expect(invalidatePages).toHaveBeenCalledWith([child._id.toString()], 'page-renamed');
      expect(invalidatePages).toHaveBeenCalledTimes(2);
    });
  });

  test('AC-31: renameTree does not lose a success that completes after a sibling failure', async () => {
    const user = await seedUser('tree-partial');
    await Page().createPage('/epoch-tree-partial-a', 'a', user, {});
    // No page exists at '/epoch-tree-partial-missing' — Page.findPageByPath
    // inside renameTree's per-item worker throws for it, captured as a
    // failure; the sibling rename must still succeed and be reported.
    const pathMap = {
      '/epoch-tree-partial-a': '/epoch-tree-partial-a-renamed',
      '/epoch-tree-partial-missing': '/epoch-tree-partial-missing-renamed',
    };
    const result = await Page().renameTree(pathMap, user, { createRedirectPage: false, preserveUpdatedAt: true });

    expect(result.successes).toHaveLength(1);
    // `Page.rename` mutates `pageData.path` on the SAME in-memory doc
    // `renameTree` returns as the success entry — it reads back as the NEW
    // (post-rename) path, not the pre-rename `oldPath` key.
    expect(result.successes[0].path).toBe('/epoch-tree-partial-a-renamed');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].oldPath).toBe('/epoch-tree-partial-missing');

    const moved = await Page().findOne({ path: '/epoch-tree-partial-a-renamed' }).exec();
    expect(moved).toBeTruthy();
  });

  test('AC-33: an absent collabAttachment (CLI / pre-boot) never breaks a rename or delete', async () => {
    const previous = crowi.collabAttachment;
    crowi.collabAttachment = null;
    try {
      const user = await seedUser('no-attachment');
      const page = await Page().createPage('/epoch-no-attachment', 'body', user, {});
      await expect(Page().rename(page, '/epoch-no-attachment-renamed', user, {})).resolves.toBeTruthy();
      const renamed = await Page().findById(page._id).exec();
      await expect(Page().deletePage(renamed, user)).resolves.toBeTruthy();
    } finally {
      crowi.collabAttachment = previous;
    }
  });
});
