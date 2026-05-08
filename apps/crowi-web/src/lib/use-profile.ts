'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { UpdateProfileRequest, UpdatePasswordRequest } from '@crowi/api-contract';

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const result = await apiClient.me.getProfile();
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to fetch profile',
      });
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateProfileRequest) => {
      const result = await apiClient.me.updateProfile({ body: data });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 400: 'Failed to update profile' },
        fallback: 'Failed to update profile',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useUploadPicture() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      // ts-rest automatically converts the body to FormData when contentType is 'multipart/form-data'
      const result = await apiClient.me.uploadPicture({
        body: { file },
      });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 400: 'Failed to upload picture' },
        fallback: 'Failed to upload picture',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useDeletePicture() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const result = await apiClient.me.deletePicture();
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 400: 'Failed to delete picture' },
        fallback: 'Failed to delete picture',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useUpdatePassword() {
  return useMutation({
    mutationFn: async (data: UpdatePasswordRequest) => {
      const result = await apiClient.me.updatePassword({ body: data });
      // 400 surfaces a structured `{ errors: string[], message? }` shape so we
      // can join multiple validation messages — special-case it inline rather
      // than going through unwrapResult's wire-message extraction.
      if (result.status === 200) return result.body;
      if (result.status === 400) {
        const errors = result.body.errors || [];
        throw new Error(errors.length > 0 ? errors.join(', ') : result.body.message || 'Failed to update password');
      }
      throw new Error('Failed to update password');
    },
  });
}

export function useApiToken() {
  return useQuery({
    queryKey: ['apiToken'],
    queryFn: async () => {
      const result = await apiClient.me.getApiToken();
      return unwrapResult(result, {
        ok: (body) => body,
        fallback: 'Failed to fetch API token',
      });
    },
  });
}

export function useResetApiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const result = await apiClient.me.resetApiToken();
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 500: 'Failed to reset API token' },
        fallback: 'Failed to reset API token',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apiToken'] });
    },
  });
}
