import { z } from '@hono/zod-openapi';

import { UsernameSchema } from './username';

export const InstallerStatusResponseSchema = z.object({
  status: z.enum(['installer_required', 'already_installed']),
});

export const CreateAdminRequestSchema = z.object({
  registerForm: z.object({
    username: UsernameSchema,
    name: z.string().min(1),
    email: z.string().email(),
    password: z
      .string()
      .min(6)
      .regex(/^[\x20-\x7F]{6,}$/, 'password must be 6+ printable ASCII characters'),
  }),
});

export const CreateAdminResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  message: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
