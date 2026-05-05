import { z } from 'zod';

// Language enum - matches User model
export const LanguageSchema = z.enum(['en', 'en-US', 'en-GB', 'ja']);
export type Language = z.infer<typeof LanguageSchema>;

// User profile response schema
export const UserProfileResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  lang: LanguageSchema,
  image: z.string().nullable(),
  introduction: z.string().optional(),
  googleId: z.string().nullable().optional(),
  githubId: z.string().nullable().optional(),
  hasPassword: z.boolean(),
  createdAt: z.string(),
});
export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;

// Update profile request schema
export const UpdateProfileRequestSchema = z.object({
  userForm: z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email format'),
    lang: LanguageSchema,
  }),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// Picture upload response schema
export const PictureUploadResponseSchema = z.object({
  status: z.boolean(),
  url: z.string().optional(),
  message: z.string().optional(),
});
export type PictureUploadResponse = z.infer<typeof PictureUploadResponseSchema>;

// Generic success response schema
export const SuccessResponseSchema = z.object({
  status: z.literal('ok'),
  message: z.string().optional(),
});
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

// Error response schema for profile operations
export const ProfileErrorResponseSchema = z.object({
  status: z.literal('error'),
  message: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
export type ProfileErrorResponse = z.infer<typeof ProfileErrorResponseSchema>;

// Password validation regex
// New password must contain at least one letter, one digit, and one special character
// Allowed special characters: !@#$%^&*()_+-=[]{};\:'"|,.<>/?`~
const PASSWORD_REGEX = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~])[a-zA-Z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/;

// Password update request schema
export const UpdatePasswordRequestSchema = z
  .object({
    oldPassword: z.string().optional(),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(100, 'Password must be at most 100 characters')
      .regex(PASSWORD_REGEX, 'Password must contain at least one letter, one digit, and one special character'),
    newPasswordConfirm: z.string(),
  })
  .refine((data) => data.newPassword === data.newPasswordConfirm, {
    message: 'Passwords do not match',
    path: ['newPasswordConfirm'],
  });
export type UpdatePasswordRequest = z.infer<typeof UpdatePasswordRequestSchema>;

// Password update success response schema
export const PasswordUpdateSuccessSchema = z.object({
  status: z.literal('ok'),
  message: z.string(),
});
export type PasswordUpdateSuccess = z.infer<typeof PasswordUpdateSuccessSchema>;

// Password error response schema
export const PasswordErrorResponseSchema = z.object({
  status: z.literal('error'),
  message: z.string(),
  errors: z.array(z.string()).optional(),
});
export type PasswordErrorResponse = z.infer<typeof PasswordErrorResponseSchema>;

// API Token response schema
export const ApiTokenResponseSchema = z.object({
  status: z.literal('ok'),
  apiToken: z.string(),
});
export type ApiTokenResponse = z.infer<typeof ApiTokenResponseSchema>;

// API Token error response schema
export const ApiTokenErrorResponseSchema = z.object({
  status: z.literal('error'),
  message: z.string(),
});
export type ApiTokenErrorResponse = z.infer<typeof ApiTokenErrorResponseSchema>;
