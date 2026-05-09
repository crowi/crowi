'use client';

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type {
  AdminUserMutationResponse,
  EditAdminUserRequest,
  InviteUsersRequest,
  InviteUsersResponse,
  ListAdminUsersResponse,
  ResetPasswordResponse,
  UpdateAdminUserEmailRequest,
} from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

/**
 * Query parameters accepted by `useAdminUsers`. Matches the wire shape of
 * GET /admin/users (q + page + limit) but everything is optional so the
 * caller only needs to spread URL search params.
 */
export interface UseAdminUsersParams {
  q?: string;
  page?: number;
  limit?: number;
}

export const adminUsersKeys = {
  all: ['admin', 'users'] as const,
  list: (params: UseAdminUsersParams) => [...adminUsersKeys.all, 'list', params.q ?? '', params.page ?? 1, params.limit ?? 50] as const,
};

/**
 * Fetch the paginated admin user list. Mirrors the patterns in
 * `useAdminSecuritySettings`:
 * - 401 / 403 are surfaced as Errors so the caller renders an alert instead
 *   of the loaded shape (the `(admin)` layout normally guards on user.admin
 *   so these only fire on backend regressions).
 * - `staleTime` is short — admin operators expect the list to reflect their
 *   recent changes (invitations from the legacy flow / status edits / etc.).
 * - `keepPreviousData` keeps the table populated while typing in the search
 *   box so the UI does not flash empty between requests.
 */
export function useAdminUsers(params: UseAdminUsersParams) {
  return useQuery({
    queryKey: adminUsersKeys.list(params),
    queryFn: async (): Promise<ListAdminUsersResponse> => {
      const result = await apiClient.admin.users.listUsers({
        query: {
          q: params.q,
          page: params.page,
          limit: params.limit,
        },
      });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 401: 'Failed to fetch users', 403: 'Failed to fetch users' },
        fallback: 'Failed to fetch users',
      });
    },
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Custom error thrown by `useEditAdminUser` and `useUpdateAdminUserEmail` when
 * the server returns 409 Conflict (email collision with another user).
 *
 * Caller code uses `instanceof EmailConflictError` in the mutation `onError`
 * to map the failure onto the email field instead of a global toast.
 */
export class EmailConflictError extends Error {
  constructor(message?: string) {
    super(message ?? m['admin.users.action.email_conflict']());
    this.name = 'EmailConflictError';
  }
}

type ApiResult = { status: number; body: unknown };
type ErrorBody = { error?: { message?: string } };

/**
 * Map a ts-rest mutation response onto a typed return value or throw, with the
 * status ladder common to every per-user mutating endpoint:
 * - 200 → return body as `T`
 * - 401/403 → generic unauthorized
 * - 404 → user-not-found
 * - 409 → caller-provided ctor (so `EmailConflictError` is thrown only where it's meaningful)
 * - else → caller-provided fallback message
 */
function unwrapAdminUserResult<T>(result: ApiResult, opts: { fallback: string; onConflict?: (msg?: string) => Error }): T {
  if (result.status === 200) return result.body as T;
  const body = result.body as ErrorBody | undefined;
  if (result.status === 409 && opts.onConflict) {
    throw opts.onConflict(body?.error?.message);
  }
  if (result.status === 401 || result.status === 403) {
    throw new Error(m['errors.unauthorized']());
  }
  if (result.status === 404) {
    throw new Error(m['admin.users.action.user_not_found']());
  }
  throw new Error(opts.fallback);
}

const onConflictAsEmailConflict = (msg?: string) => new EmailConflictError(msg);

/**
 * POST /admin/users/invite — bulk-invite by email.
 *
 * On success the list is invalidated so newly-created users appear in the
 * table. The per-email outcome is *not* automatically displayed — the calling
 * UI keeps the response so the operator can review created / exists / failed
 * rows in the invite dialog before dismissing it.
 */
export function useInviteAdminUsers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: InviteUsersRequest): Promise<InviteUsersResponse> => {
      const result = await apiClient.admin.users.inviteUsers({ body });
      return unwrapAdminUserResult<InviteUsersResponse>(result, { fallback: m['admin.users.action.invite_failed']() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * PATCH /admin/users/:id — update name and email together.
 *
 * 409 Conflict is mapped to `EmailConflictError` so the calling form can
 * highlight the email field instead of showing a generic alert. Other 4xx
 * status codes fall through to a generic Error.
 */
export function useEditAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: EditAdminUserRequest }): Promise<AdminUserMutationResponse> => {
      const result = await apiClient.admin.users.editUser({ params: { id: params.id }, body: params.body });
      return unwrapAdminUserResult<AdminUserMutationResponse>(result, {
        fallback: m['admin.users.action.edit_failed'](),
        onConflict: onConflictAsEmailConflict,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * Toggle admin permission on a single user.
 *
 * The hook accepts a `nextAdmin` flag so the caller does not need to pick
 * between two endpoints — `true` calls makeAdmin (PUT), `false` calls
 * removeFromAdmin (DELETE). Both endpoints share the same response shape and
 * error mapping.
 */
export function useToggleAdminRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; nextAdmin: boolean }): Promise<AdminUserMutationResponse> => {
      const result = params.nextAdmin
        ? await apiClient.admin.users.makeAdmin({ params: { id: params.id }, body: {} })
        : await apiClient.admin.users.removeFromAdmin({ params: { id: params.id }, body: {} });
      return unwrapAdminUserResult<AdminUserMutationResponse>(result, { fallback: m['admin.users.action.role_failed']() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * Toggle account status (active / suspended).
 *
 * Like `useToggleAdminRole` this folds the two REST endpoints into one hook
 * keyed by a `nextStatus` discriminator. The deleted / registered / invited
 * states are not exposed through this hook because the legacy admin UI did
 * not have actions for them either.
 */
export function useToggleAdminStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; nextStatus: 'active' | 'suspended' }): Promise<AdminUserMutationResponse> => {
      const result =
        params.nextStatus === 'active'
          ? await apiClient.admin.users.activateUser({ params: { id: params.id }, body: {} })
          : await apiClient.admin.users.suspendUser({ params: { id: params.id }, body: {} });
      return unwrapAdminUserResult<AdminUserMutationResponse>(result, { fallback: m['admin.users.action.status_failed']() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * POST /admin/users/:id/reset-password — issue a fresh random password.
 *
 * The plaintext is returned in the response and is shown to the operator
 * exactly once via a result dialog. We invalidate the list so any
 * passwordSeed-derived display changes refresh, even though the visible
 * fields don't normally change.
 */
export function useResetAdminUserPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string }): Promise<ResetPasswordResponse> => {
      const result = await apiClient.admin.users.resetPassword({ params: { id: params.id }, body: {} });
      return unwrapAdminUserResult<ResetPasswordResponse>(result, { fallback: m['admin.users.action.reset_password_failed']() });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * PUT /admin/users/:id/email — change a single user's email.
 *
 * Same 409 -> EmailConflictError mapping as `useEditAdminUser` so the dialog
 * can surface the duplicate inline.
 */
export function useUpdateAdminUserEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: UpdateAdminUserEmailRequest }): Promise<AdminUserMutationResponse> => {
      const result = await apiClient.admin.users.updateUserEmail({ params: { id: params.id }, body: params.body });
      return unwrapAdminUserResult<AdminUserMutationResponse>(result, {
        fallback: m['admin.users.action.update_email_failed'](),
        onConflict: onConflictAsEmailConflict,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}
