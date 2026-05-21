/**
 * Literal-typed error bodies reused across Hono handlers.
 *
 * Each constant matches the corresponding schema in
 * `@crowi/api-contract` (`InternalServerErrorSchema`,
 * `AuthenticationRequiredErrorSchema`). Centralising them keeps the
 * literal narrowing in one place — bare object literals lose the
 * `as const` narrowing and trip the schemas' literal checks at the
 * `c.json` typed-response boundary.
 *
 * Resource-specific error bodies (`USER_NOT_FOUND_BODY`,
 * `INVALID_CREDENTIALS_BODY` etc.) stay in their respective handler
 * files — they have no reuse benefit and keep the resource handlers
 * self-contained.
 */

export const INTERNAL_ERROR_BODY = {
  error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const },
};

export const AUTH_REQUIRED_BODY = {
  error: { code: 'AUTHENTICATION_REQUIRED' as const, message: 'Authentication is required' as const },
};
