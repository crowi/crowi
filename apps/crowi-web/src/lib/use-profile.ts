'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { UpdateProfileRequest, UpdatePasswordRequest } from '@crowi/api-contract';

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const result = await apiClient.me.getProfile();
      if (result.status === 200) {
        return result.body;
      }
      throw new Error('Failed to fetch profile');
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateProfileRequest) => {
      const result = await apiClient.me.updateProfile({ body: data });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 400) {
        throw new Error(result.body.message || 'Failed to update profile');
      }
      throw new Error('Failed to update profile');
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

      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 400) {
        throw new Error(result.body.message || 'Failed to upload picture');
      }
      throw new Error('Failed to upload picture');
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
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 400) {
        throw new Error(result.body.message || 'Failed to delete picture');
      }
      throw new Error('Failed to delete picture');
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
      if (result.status === 200) {
        return result.body;
      }
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
      if (result.status === 200) {
        return result.body;
      }
      throw new Error('Failed to fetch API token');
    },
  });
}

export function useResetApiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const result = await apiClient.me.resetApiToken();
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 500) {
        throw new Error(result.body.message || 'Failed to reset API token');
      }
      throw new Error('Failed to reset API token');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apiToken'] });
    },
  });
}
