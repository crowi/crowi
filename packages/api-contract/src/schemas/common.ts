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

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApplicationNotInstalledError = z.infer<typeof ApplicationNotInstalledErrorSchema>;