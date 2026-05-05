import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  UserProfileResponseSchema,
  UpdateProfileRequestSchema,
  PictureUploadResponseSchema,
  SuccessResponseSchema,
  ProfileErrorResponseSchema,
  UpdatePasswordRequestSchema,
  PasswordUpdateSuccessSchema,
  PasswordErrorResponseSchema,
  ApiTokenResponseSchema,
  ApiTokenErrorResponseSchema,
} from '../schemas/me';
import { AuthenticationRequiredErrorSchema, ApiErrorSchema } from '../schemas/common';

const c = initContract();

export const meContract = c.router({
  getProfile: {
    method: 'GET',
    path: '/me',
    responses: {
      200: UserProfileResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Get current user profile',
  },
  updateProfile: {
    method: 'PUT',
    path: '/me',
    body: UpdateProfileRequestSchema,
    responses: {
      200: UserProfileResponseSchema,
      400: ProfileErrorResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Update user profile',
  },
  uploadPicture: {
    method: 'POST',
    path: '/me/picture',
    contentType: 'multipart/form-data',
    body: z.object({
      file: z.any().describe('Profile picture file'),
    }),
    responses: {
      200: PictureUploadResponseSchema,
      400: ProfileErrorResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Upload profile picture',
  },
  deletePicture: {
    method: 'DELETE',
    path: '/me/picture',
    body: z.undefined(),
    responses: {
      200: SuccessResponseSchema,
      400: ProfileErrorResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Delete profile picture',
  },
  updatePassword: {
    method: 'PUT',
    path: '/me/password',
    body: UpdatePasswordRequestSchema,
    responses: {
      200: PasswordUpdateSuccessSchema,
      400: PasswordErrorResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: 'Update user password',
  },
  getApiToken: {
    method: 'GET',
    path: '/me/apiToken',
    responses: {
      200: ApiTokenResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: ApiTokenErrorResponseSchema,
    },
    summary: 'Get current user API token',
  },
  resetApiToken: {
    method: 'POST',
    path: '/me/apiToken',
    body: z.undefined(),
    responses: {
      200: ApiTokenResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: ApiTokenErrorResponseSchema,
    },
    summary: 'Reset (regenerate) API token',
  },
});
