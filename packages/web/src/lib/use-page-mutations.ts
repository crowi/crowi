'use client';

import type { PageWithRevision, RenamePageRequest, RenameSubtreeRequest, SetPageGrantRequest, UpdatePageRequest } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

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
      queryClient.invalidateQueries({ queryKey: ['page'] });
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
      queryClient.invalidateQueries({ queryKey: ['page'] });
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
      queryClient.invalidateQueries({ queryKey: ['page'] });
      // The /trash listing must drop the just-(soft|hard)-deleted row.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      // /user/:username/pages may surface deleted pages — refresh only the
      // user/<username>/pages keys, not every cache under `['user']`.
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'user' && query.queryKey[2] === 'pages',
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
      queryClient.invalidateQueries({ queryKey: ['page'] });
      // The /trash listing must drop the just-restored row.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'user' && query.queryKey[2] === 'pages',
      });
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
        const body = await response.json().catch(() => null);
        // The 400 body is a union of the generic page error and the subtree
        // RenameTreeError; the latter is the one carrying `conflicts`. The
        // generic variant's `code` is `string` (so a literal compare cannot
        // narrow it) — discriminate on the presence of `conflicts` instead.
        if (body && 'error' in body && 'conflicts' in body.error) {
          const treeError = body.error;
          throw new RenameTreeConflictError(treeError.message, treeError.conflicts, Boolean(treeError.partial));
        }
      }
      throw new Error(m['errors.rename_failed']());
    },
    onSuccess: () => {
      // A subtree rename moves many pages — invalidate the page + listing
      // caches so the sidebar tree and any list views refresh.
      queryClient.invalidateQueries({ queryKey: ['page'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
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
        // partial). Discriminate on the presence of `conflicts` — the generic
        // variant's `code` is `string` and cannot narrow as a literal.
        const body = await response.json().catch(() => null);
        if (body && 'error' in body && 'conflicts' in body.error) {
          const treeError = body.error;
          throw new RenameTreeConflictError(treeError.message, treeError.conflicts, Boolean(treeError.partial));
        }
      }
      throw new Error(m['errors.rename_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });
}
