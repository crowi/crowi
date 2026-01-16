import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  UserProfileResponseSchema,
  UpdateProfileRequestSchema,
  PictureUploadResponseSchema,
  SuccessResponseSchema,
  ProfileErrorResponseSchema,
} from '../schemas/me';
import {
  AuthenticationRequiredErrorSchema,
  ApiErrorSchema,
} from '../schemas/common';

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
    body: c.type<{ file: File }>(),
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
});
