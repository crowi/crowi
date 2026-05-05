import { z } from 'zod';

export const InstallerStatusResponseSchema = z.object({
  status: z.enum(['installer_required', 'already_installed']),
});

export const CreateAdminRequestSchema = z.object({
  registerForm: z.object({
    username: z.string(),
    name: z.string(),
    email: z.string().email(),
    password: z.string().min(6),
  }),
});

export const CreateAdminResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  message: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
