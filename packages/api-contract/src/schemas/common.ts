import { z } from '@hono/zod-openapi';

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

export const AdminRequiredErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('ADMIN_REQUIRED'),
    message: z.literal('Admin permission required'),
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

/**
 * Generic 400 returned by endpoints that perform request-level validation
 * beyond what Zod can express (e.g. missing body fields when the schema is
 * intentionally permissive, or business-rule guards). The `code` is
 * `VALIDATION_ERROR` and `message` is a human-readable summary; UIs should
 * surface it as a toast, not parse it for branching logic.
 */
export const ValidationErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('VALIDATION_ERROR'),
    message: z.string(),
    details: z
      .object({
        fieldErrors: z.record(z.string(), z.array(z.string())),
        formErrors: z.array(z.string()),
      })
      .optional(),
  }),
});

/**
 * Generic 404 for "the resource you addressed does not exist". Currently used
 * by admin user mutating endpoints (PATCH /admin/users/:id, etc.) where the
 * id resolves to no document; distinct from page-scoped 404s which carry
 * domain-specific codes.
 */
export const NotFoundErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('NOT_FOUND'),
    message: z.string(),
  }),
});

/**
 * 409 Conflict, used for "a resource with this unique key already exists".
 * Admin user endpoints raise it when an email change collides with another
 * user's address; the legacy controller surfaced this as `ApiResponse.error`
 * (HTTP 200 with `{ ok: false }`) but the new contract correctly expresses
 * the conflict at the HTTP layer.
 */
export const ConflictErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('CONFLICT'),
    message: z.string(),
  }),
});

/**
 * 503 returned when a feature requires a runtime-pluggable driver/service
 * that is not currently registered. The shape is deliberately generic so
 * it can be reused for any pluggable subsystem; the `feature` field lets
 * clients branch on which subsystem is missing without parsing `message`.
 *
 * Examples of `feature` values the API surfaces:
 *   - `'search'`  — `GET /api/v2/search` when no `@crowi/plugin-search-*`
 *                    is installed in the runner project.
 *   - `'notifier'` (future) — when no slack / chat notifier driver is registered.
 *   - `'mailer'`  (future) — when SMTP transport is not configured.
 */
export const ServiceUnavailableErrorSchema = ApiErrorSchema.extend({
  error: z.object({
    code: z.literal('SERVICE_UNAVAILABLE'),
    feature: z.string(),
    message: z.string(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApplicationNotInstalledError = z.infer<typeof ApplicationNotInstalledErrorSchema>;
export type AuthenticationRequiredError = z.infer<typeof AuthenticationRequiredErrorSchema>;
export type AdminRequiredError = z.infer<typeof AdminRequiredErrorSchema>;
export type UserStatusError = z.infer<typeof UserStatusErrorSchema>;
export type ThirdPartyAuthRequiredError = z.infer<typeof ThirdPartyAuthRequiredErrorSchema>;
export type InternalServerError = z.infer<typeof InternalServerErrorSchema>;
export type InvalidPageIdError = z.infer<typeof InvalidPageIdErrorSchema>;
export type ValidationError = z.infer<typeof ValidationErrorSchema>;
export type NotFoundError = z.infer<typeof NotFoundErrorSchema>;
export type ConflictError = z.infer<typeof ConflictErrorSchema>;
export type ServiceUnavailableError = z.infer<typeof ServiceUnavailableErrorSchema>;
