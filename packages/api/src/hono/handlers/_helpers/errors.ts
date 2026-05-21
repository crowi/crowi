/**
 * Literal-typed error bodies reused across Hono handlers.
 *
 * Each constant matches the corresponding schema in
 * `@crowi/api-contract` (`InternalServerErrorSchema`,
 * `AuthenticationRequiredErrorSchema`, `InvalidPageIdErrorSchema`).
 * Centralising them keeps the literal narrowing in one place — bare
 * object literals lose the `as const` narrowing and trip the schemas'
 * literal checks at the `c.json` typed-response boundary.
 *
 * Resource-specific bodies whose message is fixed (`USER_NOT_FOUND_BODY`,
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

/**
 * `InvalidPageIdErrorSchema` envelope. The schema's `message` is a free
 * `z.string()` (not a literal) so callers can override; the default
 * matches the legacy ts-rest era message verbatim.
 */
export const INVALID_PAGE_ID_BODY = {
  error: { code: 'INVALID_PAGE_ID' as const, message: 'Invalid page_id' as const },
};

/**
 * Factory for the generic `INVALID_REQUEST` envelope. Used when the
 * request fails a handler-level invariant that the Zod schema cannot
 * express (e.g. a query-parameter combination that is individually
 * valid but conflicts as a whole).
 */
export const invalidRequestBody = (message: string) => ({
  error: { code: 'INVALID_REQUEST' as const, message },
});
