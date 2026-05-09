import { z } from 'zod';

export const InstallerStatusResponseSchema = z.object({
  status: z.enum(['installer_required', 'already_installed']),
});

export const CreateAdminRequestSchema = z.object({
  registerForm: z.object({
    username: z
      .string()
      .min(1)
      .regex(/^[\da-zA-Z\-_.]+$/, 'username may only contain letters, digits, hyphens, underscores, and dots'),
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
