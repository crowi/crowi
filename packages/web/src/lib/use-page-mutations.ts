'use client';

import type { PageWithRevision, RenamePageRequest, RenameSubtreeRequest, SetPageGrantRequest, UpdatePageRequest } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import { PAGE_LIST_FAMILY_ROOT, pageKeys, revisionsKeys, userPageKeys } from './page-query-keys';
import { draftsKeys } from './use-drafts';

/**
 * Invalidate every query family that reflects a page's content after a
 * body-changing save:
 *   - `pageKeys.all`          — the single-page detail (both `page_id`- and
 *                               `path`-keyed `usePage` queries) → the normal
 *                               page view
 *   - `PAGE_LIST_FAMILY_ROOT` — the list / portal family (`usePageList` →
 *                               `pageListKeys`) AND the sidebar tree
 *                               (`usePageChildrenLevels` → `pageChildrenKeys`)
 *   - `revisionsKeys.all`     — the page-history list (a save pushes a new revision)
 *   - `draftsKeys.all`        — the "creating pages" list (a first save publishes a draft)
 *
 * Both save paths route through here — the realtime `crowi:save` flow
 * (which bypasses react-query entirely; see `handleAfterSave`) and the HTTP
 * `useUpdatePage` fallback — so the invalidation set can never drift between
 * them again. The portal-staleness bug came from exactly that drift: the
 * page *detail* view (`pageKeys.all`) was invalidated but the *portal* view,
 * driven by the list family (`PAGE_LIST_FAMILY_ROOT`), was not — so a portal
 * kept serving its pre-edit revision after a save. All of these keys now
 * have exactly one owner (`page-query-keys.ts`), so a future rename of a
 * root string can't drift the two apart again.
 */
export function invalidatePageContentQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: pageKeys.all });
  queryClient.invalidateQueries({ queryKey: PAGE_LIST_FAMILY_ROOT });
  queryClient.invalidateQueries({ queryKey: revisionsKeys.all });
  queryClient.invalidateQueries({ queryKey: draftsKeys.all });
}

/**
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.page.*` (ts-rest)
 * to `apiClientV2.pages.*.$method` (hc<AppType>). The legacy
 * `unwrapResult` helper is replaced with explicit `response.ok` /
 * `response.status` checks because hc returns a plain `Response`-shaped
 * object rather than ts-rest's `{ status, body }` discriminated union.
 *
 * Error messages mirror the legacy `unwrapResult` behaviour: a
 * resource-specific m['errors.*']() string for actionable cases and
 * a fallback for everything else. `PageRevisionConflictError` is still
 * thrown explicitly on 409 so callers can match on it.
 */

interface DeletePageRequest {
  page_id: string;
  revision_id?: string;
  completely?: boolean;
}

interface RevertDeletedPageRequest {
  page_id: string;
}

interface RevertToRevisionRequest {
  page_id: string;
  revision_id: string;
}

/**
 * Error thrown when a page update fails because the revision_id is stale
 * (someone else updated the page in the meantime).
 */
export class PageRevisionConflictError extends Error {
  readonly code = 'PAGE_REVISION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PageRevisionConflictError';
  }
}

/**
 * Conflict descriptor returned by a subtree rename (renameTree) when one or
 * more destination paths collide / are not a creatable name.
 */
export interface RenameTreeConflict {
  path: string;
  reasons: string[];
}

/**
 * Error thrown when a subtree rename (include_descendants:true) is refused
 * up-front because of destination collisions, or fails midway (partial). The
 * `conflicts` array carries the offending paths so the dialog can list them.
 */
export class RenameTreeConflictError extends Error {
  readonly code = 'PAGE_RENAME_TREE_FAILED' as const;
  readonly conflicts: RenameTreeConflict[];
  readonly partial: boolean;

  constructor(message: string, conflicts: RenameTreeConflict[], partial: boolean) {
    super(message);
    this.name = 'RenameTreeConflictError';
    this.conflicts = conflicts;
    this.partial = partial;
  }
}

/**
 * Result of a rename mutation: the moved (root) page plus how many pages were
 * moved (1 for a single rename, root + descendants for a subtree).
 */
export interface RenamePageResult {
  page: PageWithRevision;
  renamedCount: number;
}

/**
 * Inspect a parsed 400 body from a rename endpoint and, if it is the structured
 * PAGE_RENAME_TREE_FAILED variant (the one carrying `conflicts`), throw a
 * RenameTreeConflictError. Discriminates on the presence of `conflicts` — the
 * generic page-error variant's `code` is a plain string and cannot narrow as a
 * literal. Returns (without throwing) for any other body so the caller can fall
 * back to a generic error.
 */
function throwIfRenameTreeConflict(body: unknown): void {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === 'object' && 'conflicts' in error) {
      const treeError = error as { message: string; conflicts: RenameTreeConflict[]; partial?: boolean };
      throw new RenameTreeConflictError(treeError.message, treeError.conflicts, Boolean(treeError.partial));
    }
  }
}

export function useUpdatePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdatePageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.$put({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 409) {
        throw new PageRevisionConflictError(m['errors.revision_conflict_edit']());
      }
      if (response.status === 404) {
        // 404 covers both "page not found" and grant-denied (existence-leak
        // guard in the handler collapses both to 404).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.update_failed']());
    },
    onSuccess: () => {
      // Refresh the page detail AND the list/portal family — editing a
      // portal returns to its `usePageList` view, which would otherwise
      // keep serving the pre-edit revision. Also covers page history
      // (new revision) + drafts (a first save publishes a draft).
      invalidatePageContentQueries(queryClient);
    },
  });
}

/**
 * Update only a page's grant (visibility). Unlike `useUpdatePage` this
 * does not push a new revision — it powers the editor's visibility
 * selector, where a grant change must not land in the page history.
 */
export function useSetPageGrant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: SetPageGrantRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.grant.$put({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 404) {
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['edit.grant_update_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pageKeys.all });
    },
  });
}

/**
 * Soft-delete (or fully delete with completely=true) a page.
 * On success the returned page reflects the post-delete state:
 *  - soft delete: path is /trash/<original>, status === 'deleted'
 *  - completely=true: the page is gone from the DB; the body still echoes the
 *    original page object for client-side feedback, but a refetch will 404.
 */
export function useDeletePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: DeletePageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.$delete({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 409) {
        throw new PageRevisionConflictError(m['errors.revision_conflict_edit']());
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.delete_failed']());
    },
    onSuccess: () => {
      // Invalidate page queries so the trashed view (or 404) is reflected.
      queryClient.invalidateQueries({ queryKey: pageKeys.all });
      // The /trash listing must drop the just-(soft|hard)-deleted row.
      queryClient.invalidateQueries({ queryKey: PAGE_LIST_FAMILY_ROOT });
      // /user/:username/pages may surface deleted pages — refresh only the
      // user/<username>/pages keys, not every cache under `['user']`.
      queryClient.invalidateQueries({
        predicate: (query) => userPageKeys.isPagesQuery(query.queryKey),
      });
    },
  });
}

/**
 * Revert a soft-deleted page (the one currently sitting under /trash/...).
 * The page document's path/status are restored and the redirect stub at the
 * original path is removed.
 */
export function useRevertDeletedPage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: RevertDeletedPageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.revert.$post({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.revert_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pageKeys.all });
      // The /trash listing must drop the just-restored row.
      queryClient.invalidateQueries({ queryKey: PAGE_LIST_FAMILY_ROOT });
      queryClient.invalidateQueries({
        predicate: (query) => userPageKeys.isPagesQuery(query.queryKey),
      });
    },
  });
}

/**
 * Revert a page's body to one of its PAST revisions. Non-destructive: the
 * old body is stacked as a NEW revision on top of the current latest, so the
 * whole history is preserved. The revert always lands on top of the
 * server-side latest (no optimistic lock / 409), so a stale `revision_id`
 * the caller is *viewing* can still be reverted to. Returns the page with
 * the new revision as its latest.
 */
export function useRevertToRevision() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: RevertToRevisionRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages['revert-to-revision'].$post({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.revert_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pageKeys.all });
      // The revert can be triggered from a portal listing, so refresh the
      // page lists too: the portal document now sits at a new latest revision.
      queryClient.invalidateQueries({ queryKey: PAGE_LIST_FAMILY_ROOT });
      // A new revision was stacked — refresh the page-history list so the
      // reverted revision shows immediately. Without this the history view
      // serves the pre-revert revisions off the 60s default staleTime and the
      // new one only appears after a full browser reload.
      queryClient.invalidateQueries({ queryKey: revisionsKeys.all });
    },
  });
}

/**
 * Rename (move) a page to a new path. May also unlink an existing redirect
 * page sitting at the new path on the server side.
 */
export function useRenamePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: RenamePageRequest): Promise<RenamePageResult> => {
      const response = await apiClientV2.pages.rename.$post({ json: data });
      if (response.ok) {
        const body = await response.json();
        return {
          page: body.page as PageWithRevision,
          renamedCount: 'renamed_count' in body ? body.renamed_count : 1,
        };
      }
      if (response.status === 409) {
        throw new PageRevisionConflictError(m['errors.revision_conflict_update']());
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      if (response.status === 400) {
        // A subtree rename can fail with a structured PAGE_RENAME_TREE_FAILED
        // body (destination collisions / partial move). Surface the offending
        // paths so the dialog can list them.
        throwIfRenameTreeConflict(await response.json().catch(() => null));
      }
      throw new Error(m['errors.rename_failed']());
    },
    onSuccess: () => {
      // A subtree rename moves many pages — invalidate the page + listing
      // caches so the sidebar tree and any list views refresh.
      queryClient.invalidateQueries({ queryKey: pageKeys.all });
      queryClient.invalidateQueries({ queryKey: PAGE_LIST_FAMILY_ROOT });
    },
  });
}

/**
 * Rename (move) a whole subtree by path — for a portal-less folder that has no
 * page document of its own (so there is no page_id to key `useRenamePage` on).
 * Always a subtree move; returns how many pages were rewritten.
 */
export function useRenameSubtree() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: RenameSubtreeRequest): Promise<number> => {
      const response = await apiClientV2.pages['rename-subtree'].$post({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.renamed_count;
      }
      if (response.status === 400) {
        // Structured PAGE_RENAME_TREE_FAILED (collisions / nothing to move /
        // partial), or a generic 400 → fall through to the generic error.
        throwIfRenameTreeConflict(await response.json().catch(() => null));
      }
      throw new Error(m['errors.rename_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pageKeys.all });
      queryClient.invalidateQueries({ queryKey: PAGE_LIST_FAMILY_ROOT });
    },
  });
}
