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

export interface UseAdminUsersParams {
  q?: string;
  page?: number;
  limit?: number;
}

export const adminUsersKeys = {
  all: ['admin', 'users'] as const,
  list: (params: UseAdminUsersParams) => [...adminUsersKeys.all, 'list', params.q ?? '', params.page ?? 1, params.limit ?? 50] as const,
};

export function useAdminUsers(params: UseAdminUsersParams) {
  return useQuery({
    queryKey: adminUsersKeys.list(params),
    queryFn: async (): Promise<ListAdminUsersResponse> => {
      const result = await apiClient.admin.users.listUsers({
        query: { q: params.q, page: params.page, limit: params.limit },
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
 * Thrown by edit / update-email hooks on 409 so the calling form can map the
 * failure onto the email field instead of a global toast.
 */
export class EmailConflictError extends Error {
  constructor(message?: string) {
    super(message ?? m['admin.users.action.email_conflict']());
    this.name = 'EmailConflictError';
  }
}

const adminUserErrors = () =>
  ({
    401: m['errors.unauthorized'](),
    403: m['errors.unauthorized'](),
    404: m['admin.users.action.user_not_found'](),
  }) as const;

const editConflictErrors = () => ({
  ...adminUserErrors(),
  409: { message: m['admin.users.action.email_conflict'](), ErrorClass: EmailConflictError },
});

export function useInviteAdminUsers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: InviteUsersRequest): Promise<InviteUsersResponse> => {
      const fallback = m['admin.users.action.invite_failed']();
      const result = await apiClient.admin.users.inviteUsers({ body });
      return unwrapResult(result, {
        ok: (b) => b,
        errors: adminUserErrors(),
        fallback,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

export function useEditAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: EditAdminUserRequest }): Promise<AdminUserMutationResponse> => {
      const fallback = m['admin.users.action.edit_failed']();
      const result = await apiClient.admin.users.editUser({ params: { id: params.id }, body: params.body });
      return unwrapResult(result, {
        ok: (b) => b,
        errors: editConflictErrors(),
        fallback,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

export function useToggleAdminRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; nextAdmin: boolean }): Promise<AdminUserMutationResponse> => {
      const fallback = m['admin.users.action.role_failed']();
      const result = params.nextAdmin
        ? await apiClient.admin.users.makeAdmin({ params: { id: params.id }, body: {} })
        : await apiClient.admin.users.removeFromAdmin({ params: { id: params.id }, body: {} });
      return unwrapResult(result, {
        ok: (b) => b,
        errors: adminUserErrors(),
        fallback,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

export function useToggleAdminStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; nextStatus: 'active' | 'suspended' }): Promise<AdminUserMutationResponse> => {
      const fallback = m['admin.users.action.status_failed']();
      const result =
        params.nextStatus === 'active'
          ? await apiClient.admin.users.activateUser({ params: { id: params.id }, body: {} })
          : await apiClient.admin.users.suspendUser({ params: { id: params.id }, body: {} });
      return unwrapResult(result, {
        ok: (b) => b,
        errors: adminUserErrors(),
        fallback,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * No `invalidateQueries` on success: a password reset doesn't change any
 * field that the list view shows, so refetching is wasted bandwidth.
 */
export function useResetAdminUserPassword() {
  return useMutation({
    mutationFn: async (params: { id: string }): Promise<ResetPasswordResponse> => {
      const fallback = m['admin.users.action.reset_password_failed']();
      const result = await apiClient.admin.users.resetPassword({ params: { id: params.id }, body: {} });
      return unwrapResult(result, {
        ok: (b) => b,
        errors: adminUserErrors(),
        fallback,
      });
    },
  });
}

export function useUpdateAdminUserEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: UpdateAdminUserEmailRequest }): Promise<AdminUserMutationResponse> => {
      const fallback = m['admin.users.action.update_email_failed']();
      const result = await apiClient.admin.users.updateUserEmail({ params: { id: params.id }, body: params.body });
      return unwrapResult(result, {
        ok: (b) => b,
        errors: editConflictErrors(),
        fallback,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}
