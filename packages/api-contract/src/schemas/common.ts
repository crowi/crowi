import { z } from 'zod';

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.any().optional(),
  }),
});

export const ApplicationNotInstalledErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('APPLICATION_NOT_INSTALLED'),
    message: z.literal('Application is not installed'),
    redirectTo: z.literal('/installer'),
  }),
});

export const AuthenticationRequiredErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('AUTHENTICATION_REQUIRED'),
    message: z.literal('Authentication is required'),
    redirectTo: z.string().optional(),
  }),
});

export const UserStatusErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.enum(['USER_REGISTERED', 'USER_SUSPENDED', 'USER_INVITED']),
    message: z.string(),
    redirectTo: z.string(),
  }),
});

export const ThirdPartyAuthRequiredErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('THIRD_PARTY_AUTH_REQUIRED'),
    message: z.literal('Third party authentication is required'),
    redirectTo: z.string(),
  }),
});

export const InternalServerErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('INTERNAL_ERROR'),
    message: z.literal('Internal server error'),
  }),
});

export const InvalidPageIdErrorSchema = z.object({
  error: z.object({
    code: z.literal('INVALID_PAGE_ID'),
    message: z.string(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApplicationNotInstalledError = z.infer<typeof ApplicationNotInstalledErrorSchema>;
export type AuthenticationRequiredError = z.infer<typeof AuthenticationRequiredErrorSchema>;
export type UserStatusError = z.infer<typeof UserStatusErrorSchema>;
export type ThirdPartyAuthRequiredError = z.infer<typeof ThirdPartyAuthRequiredErrorSchema>;
export type InternalServerError = z.infer<typeof InternalServerErrorSchema>;
export type InvalidPageIdError = z.infer<typeof InvalidPageIdErrorSchema>;
