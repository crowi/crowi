import { z } from '@hono/zod-openapi';
import { PageSchema } from './page';

// Language enum - matches User model. Only `en` / `ja` are live UI locales
// (paraglide `locales`); the legacy regional variants (`en-US` / `en-GB`) were
// retired. Existing rows carrying them are normalised to `en` on read (see
// `userToProfileResponse`) and coerced on write (User `pre('validate')` hook).
export const LanguageSchema = z.enum(['en', 'ja']);
export type Language = z.infer<typeof LanguageSchema>;

// Theme enum - matches User model. `system` follows the OS setting.
export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

// User profile response schema
export const UserProfileResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  lang: LanguageSchema,
  theme: ThemeSchema,
  image: z.string().nullable(),
  introduction: z.string().optional(),
  hasPassword: z.boolean(),
  createdAt: z.string(),
  /**
   * True when the profile update requested a new email that is awaiting
   * confirmation: the stored `email` is unchanged and a confirmation
   * link was sent to the new address.
   */
  emailChangePending: z.boolean().optional(),
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

// Update theme request schema. Theme is synced on its own lightweight
// endpoint (driven by the header / sign-in toggle) rather than via the full
// profile form, so the `next-themes` change can persist without resubmitting
// name / email.
export const UpdateThemeRequestSchema = z.object({
  theme: ThemeSchema,
});
export type UpdateThemeRequest = z.infer<typeof UpdateThemeRequestSchema>;

// Theme update response schema.
export const ThemeUpdateResponseSchema = z.object({
  status: z.literal('ok'),
  theme: ThemeSchema,
});
export type ThemeUpdateResponse = z.infer<typeof ThemeUpdateResponseSchema>;

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
  /** Stable code so the web can localize the message (e.g. EMAIL_TAKEN). */
  code: z.string().optional(),
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

export const RecentlyViewedPagesResponseSchema = z.object({
  pages: z.array(PageSchema),
});
export type RecentlyViewedPagesResponse = z.infer<typeof RecentlyViewedPagesResponseSchema>;
