import type { ErrorCode } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

/**
 * Localize a server-returned error `code` for display.
 *
 * The API returns machine-readable `ErrorCode`s (see
 * `@crowi/api-contract`'s `ERROR_CODES`) plus an English `message` meant as a
 * developer-facing fallback. This helper turns a code into the viewer's
 * locale via paraglide, falling back to the server `message` (or a generic
 * "unknown" string) when the code is missing/unrecognised.
 *
 * Usage from a mutation hook + form:
 *
 *   // hook: carry the wire code on the thrown error
 *   const err = new Error(body.error?.message) as Error & { code?: string };
 *   err.code = body.error?.code;
 *   throw err;
 *
 *   // component: localize at display time
 *   catch (e) {
 *     const code = (e as { code?: string }).code;
 *     setError(errorMessage(code, e instanceof Error ? e.message : undefined));
 *   }
 */

/**
 * A paraglide message accessor. Every `errors.*` message is parameterless,
 * so the call signature collapses to `() => string` for our purposes.
 */
type MessageFn = () => string;

/**
 * Exhaustive `ErrorCode -> localized message` table.
 *
 * Typed as `Record<ErrorCode, MessageFn>` via `satisfies` so that adding a
 * new code to `ERROR_CODES` (in `@crowi/api-contract`) without a web mapping
 * here is a compile error — the contract and the UI can never drift.
 *
 * Several codes intentionally reuse a pre-existing `errors.*` key (e.g.
 * `AUTHENTICATION_REQUIRED -> errors.auth_required`) rather than renaming the
 * key, to avoid churn in call sites that already use those keys directly.
 */
export const ERROR_MESSAGE_KEYS = {
  // auth / permission / user status
  AUTHENTICATION_REQUIRED: m['errors.auth_required'],
  ADMIN_REQUIRED: m['errors.admin_required'],
  THIRD_PARTY_AUTH_REQUIRED: m['errors.third_party_auth_required'],
  USER_REGISTERED: m['errors.user_registered'],
  USER_SUSPENDED: m['errors.user_suspended'],
  USER_INVITED: m['errors.user_invited'],
  USER_NOT_ACTIVE: m['errors.user_not_active'],
  EMAIL_NOT_CONFIRMED: m['errors.email_not_confirmed'],
  // generic / transport
  INTERNAL_ERROR: m['errors.internal_error'],
  VALIDATION_ERROR: m['errors.validation_error'],
  INVALID_REQUEST: m['errors.invalid_request'],
  NOT_FOUND: m['errors.not_found'],
  CONFLICT: m['errors.conflict_generic'],
  SERVICE_UNAVAILABLE: m['errors.service_unavailable'],
  APPLICATION_NOT_INSTALLED: m['errors.application_not_installed'],
  // page domain
  INVALID_PAGE_ID: m['errors.invalid_page_id'],
  PAGE_NOT_FOUND: m['errors.page_not_found'],
  PAGE_NOT_GRANTED: m['errors.page_not_granted'],
  PAGE_REVISION_ERROR: m['errors.page_revision_error'],
  INVALID_GRANT: m['errors.invalid_grant'],
  // comment / notification
  COMMENT_NOT_FOUND: m['errors.comment_not_found'],
  NOTIFICATION_NOT_FOUND: m['errors.notification_not_found'],
  // user / account
  USER_NOT_FOUND: m['errors.user_not_found'],
  USER_EXISTS: m['errors.user_exists'],
  USERNAME_TAKEN: m['errors.username_taken'],
  EMAIL_TAKEN: m['errors.email_taken'],
  EMAIL_NOT_ALLOWED: m['errors.email_not_allowed'],
  // token flows
  INVALID_ACTIVATION_TOKEN: m['errors.invalid_activation_token'],
  INVALID_INVITE_TOKEN: m['errors.invalid_invite_token'],
  INVITE_ALREADY_ACCEPTED: m['errors.invite_already_accepted'],
  INVALID_RESET_TOKEN: m['errors.invalid_reset_token'],
  INVALID_EMAIL_CHANGE_TOKEN: m['errors.invalid_email_change_token'],
  // login / registration
  INVALID_CREDENTIALS: m['errors.invalid_credentials'],
  REFRESH_TOKEN_REQUIRED: m['errors.refresh_token_required'],
  REGISTRATION_CLOSED: m['errors.registration_closed'],
  PASSWORD_AUTH_REQUIRES_THIRDPARTY: m['errors.password_auth_requires_thirdparty'],
  // admin subsystems
  ENCRYPTION_NOT_CONFIGURED: m['errors.encryption_key_not_set'],
  MAIL_TEST_FAILED: m['errors.mail_test_failed'],
  PLUGIN_NOT_FOUND: m['errors.plugin_not_found'],
  PLUGIN_CONFIG_VALIDATION_FAILED: m['errors.plugin_config_validation_failed'],
} satisfies Record<ErrorCode, MessageFn>;

const isKnownCode = (code: string): code is ErrorCode => code in ERROR_MESSAGE_KEYS;

/**
 * Resolve a localized message for a server error `code`.
 *
 * - Known code -> its paraglide message (in the active locale).
 * - Unknown / missing code -> `fallback` (the server English `message`),
 *   or a generic localized "unexpected error" string when no fallback given.
 */
export function errorMessage(code?: string, fallback?: string): string {
  if (code && isKnownCode(code)) {
    return ERROR_MESSAGE_KEYS[code]();
  }
  return fallback || m['errors.unknown']();
}
