/**
 * `OpenAPIHono` defaultHook — runs whenever request validation fails
 * (zod parse error on `params`, `query`, `headers`, `body`, or `cookies`).
 *
 * Emits the `ValidationErrorSchema` wire shape with `details = error.flatten()`
 * (= `{ fieldErrors, formErrors }`) so the web client can mark form inputs
 * uniformly.
 *
 * The two admin routes that expose a *different* envelope (`PUT
 * /api/admin/app` and `PUT /api/admin/mail` use
 * `AppSettingsValidationError` / `MailSettingsValidationError` with
 * `{ bodyResult: { issues, name } }`) override this hook per-route via
 * `createRoute({ hook: ... })` at port time.
 */
import type { ValidationErrorSchema } from '@crowi/api-contract';
import type { Context } from 'hono';
import type { ZodError, z } from 'zod';

type ValidationError = z.infer<typeof ValidationErrorSchema>;

interface ValidationHookResult {
  success: boolean;
  error?: ZodError;
}

export const defaultHook = (result: ValidationHookResult, c: Context): Response | undefined => {
  if (result.success) return;
  const body: ValidationError = {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: result.error?.flatten(),
    },
  };
  return c.json(body, 400);
};
