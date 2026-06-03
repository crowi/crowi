'use client';

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type {
  AdminUserMutationResponse,
  DeleteAdminUserResponse,
  EditAdminUserRequest,
  InviteUsersRequest,
  InviteUsersResponse,
  ListAdminUsersResponse,
  PendingUsersCountResponse,
  ResetPasswordResponse,
  UpdateAdminUserEmailRequest,
} from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export interface UseAdminUsersParams {
  q?: string;
  /** Numeric user-status filter (see UserStatusEnum); used by the approval queue. */
  status?: number;
  page?: number;
  limit?: number;
}

export const adminUsersKeys = {
  all: ['admin', 'users'] as const,
  list: (params: UseAdminUsersParams) =>
    [...adminUsersKeys.all, 'list', params.q ?? '', params.status ?? '', params.page ?? 1, params.limit ?? 50] as const,
  pendingCount: () => [...adminUsersKeys.all, 'pending-count'] as const,
};

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

const readWireMessage = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } } | null;
    const msg = body?.error?.message;
    return typeof msg === 'string' ? msg : undefined;
  } catch {
    return undefined;
  }
};

const throwAdminUserError = async (response: Response, fallback: string): Promise<never> => {
  const wire = await readWireMessage(response);
  if (response.status === 401 || response.status === 403) {
    throw new Error(wire ?? m['errors.unauthorized']());
  }
  if (response.status === 404) {
    throw new Error(wire ?? m['admin.users.action.user_not_found']());
  }
  throw new Error(wire ?? fallback);
};

const throwAdminUserEditError = async (response: Response, fallback: string): Promise<never> => {
  const wire = await readWireMessage(response);
  if (response.status === 409) {
    throw new EmailConflictError(wire ?? m['admin.users.action.email_conflict']());
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(wire ?? m['errors.unauthorized']());
  }
  if (response.status === 404) {
    throw new Error(wire ?? m['admin.users.action.user_not_found']());
  }
  throw new Error(wire ?? fallback);
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.users.*`
 * (ts-rest) to `apiClientV2.admin.users.*.$method` (hc<AppType>). Wire
 * payload byte-identical; 409 still surfaces `EmailConflictError`.
 */
export function useAdminUsers(params: UseAdminUsersParams) {
  return useQuery({
    queryKey: adminUsersKeys.list(params),
    queryFn: async (): Promise<ListAdminUsersResponse> => {
      const toQ = (v: number | undefined) => (v === undefined ? undefined : String(v));
      const response = await apiClientV2.admin.users.$get({
        query: {
          q: params.q,
          status: toQ(params.status),
          page: toQ(params.page),
          limit: toQ(params.limit),
        },
      });
      if (response.status === 200) return (await response.json()) as ListAdminUsersResponse;
      return throwAdminUserError(response, 'Failed to fetch users');
    },
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useInviteAdminUsers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: InviteUsersRequest): Promise<InviteUsersResponse> => {
      const response = await apiClientV2.admin.users.invite.$post({ json: body });
      if (response.status === 200) return (await response.json()) as InviteUsersResponse;
      return throwAdminUserError(response, m['admin.users.action.invite_failed']());
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
      const response = await apiClientV2.admin.users[':id'].$patch({
        param: { id: params.id },
        json: params.body,
      });
      if (response.status === 200) return (await response.json()) as AdminUserMutationResponse;
      return throwAdminUserEditError(response, m['admin.users.action.edit_failed']());
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
      const response = params.nextAdmin
        ? await apiClientV2.admin.users[':id'].admin.$put({ param: { id: params.id } })
        : await apiClientV2.admin.users[':id'].admin.$delete({ param: { id: params.id } });
      if (response.status === 200) return (await response.json()) as AdminUserMutationResponse;
      return throwAdminUserError(response, m['admin.users.action.role_failed']());
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
      const response =
        params.nextStatus === 'active'
          ? await apiClientV2.admin.users[':id'].status.active.$put({ param: { id: params.id } })
          : await apiClientV2.admin.users[':id'].status.suspended.$put({ param: { id: params.id } });
      if (response.status === 200) return (await response.json()) as AdminUserMutationResponse;
      return throwAdminUserError(response, m['admin.users.action.status_failed']());
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
      const response = await apiClientV2.admin.users[':id']['reset-password'].$post({
        param: { id: params.id },
      });
      if (response.status === 200) return (await response.json()) as ResetPasswordResponse;
      return throwAdminUserError(response, m['admin.users.action.reset_password_failed']());
    },
  });
}

export function useUpdateAdminUserEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; body: UpdateAdminUserEmailRequest }): Promise<AdminUserMutationResponse> => {
      const response = await apiClientV2.admin.users[':id'].email.$put({
        param: { id: params.id },
        json: params.body,
      });
      if (response.status === 200) return (await response.json()) as AdminUserMutationResponse;
      return throwAdminUserEditError(response, m['admin.users.action.update_email_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * Physically removes an INVITED user. The API rejects non-invited users with
 * 409; we surface that as a plain error so the caller can show a toast.
 */
export function useDeleteAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string }): Promise<DeleteAdminUserResponse> => {
      const response = await apiClientV2.admin.users[':id'].$delete({ param: { id: params.id } });
      if (response.status === 200) return (await response.json()) as DeleteAdminUserResponse;
      return throwAdminUserError(response, m['admin.users.action.delete_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminUsersKeys.all });
    },
  });
}

/**
 * Number of users awaiting admin approval (status REGISTERED). Refetched on a
 * 60s interval (and on window focus) so the sidebar approval badge stays
 * roughly fresh while an admin works elsewhere in the panel.
 */
export function useAdminPendingUsersCount() {
  return useQuery({
    queryKey: adminUsersKeys.pendingCount(),
    queryFn: async (): Promise<PendingUsersCountResponse> => {
      const response = await apiClientV2.admin.users['pending-count'].$get();
      if (response.status === 200) return (await response.json()) as PendingUsersCountResponse;
      return throwAdminUserError(response, 'Failed to fetch pending user count');
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
  });
}
