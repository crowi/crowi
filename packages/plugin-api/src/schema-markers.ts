import type { z } from 'zod';

/**
 * `configSchema` description-string markers.
 *
 * The admin UI walks the schema and looks at each field's
 * `description` (set via `z.string().describe('@sensitive ...')`). A
 * description starting with one of these marker tokens unlocks special
 * UI behaviour without forcing every field to declare a custom Zod
 * type.
 */

/**
 * Marker that flags a config field as sensitive (encrypted at rest).
 * Usage:
 *
 *   z.string().describe('@sensitive AWS secret access key')
 *
 * The runtime auto-encrypts on write and decrypts on read, using the
 * same KeyProvider as core sensitive Config. The admin UI renders the
 * field via `<SecretField>` (saved badge / clear pending / undo).
 */
export const SENSITIVE_FIELD_MARKER = '@sensitive';

/**
 * Marker that adds an action button next to a config field. Usage:
 *
 *   z.string().describe('@action "Test connection" POST /test')
 *
 * The admin form renders a button with the given label that calls the
 * plugin's contributed endpoint at the given verb / path (relative to
 * `/api/v2/plugins/<name>/`). Useful for "Test connection",
 * "Authorise with Google", etc. without forcing every plugin to ship
 * its own React component.
 */
export const ACTION_FIELD_MARKER = '@action';

/**
 * True if the schema field is marked `@sensitive`.
 *
 * `field` is `z.ZodTypeAny` (intentionally loose); call sites pass the
 * value type from `configSchema.shape[key]`.
 */
export function isSensitiveField(field: z.ZodTypeAny): boolean {
  const description = field.description;
  return typeof description === 'string' && description.trimStart().startsWith(SENSITIVE_FIELD_MARKER);
}

/**
 * Parsed `@action` annotation extracted from a field's `description`.
 */
export interface ActionAnnotation {
  /** Visible button label, e.g. "Test connection". */
  label: string;
  /** HTTP verb of the plugin endpoint to call. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path relative to `/api/v2/plugins/<name>/`, with leading slash. */
  path: string;
}

/**
 * Parse an `@action` annotation off a field, or return null if absent.
 *
 * Format: `@action "<label>" <METHOD> <path>`
 *   e.g. `@action "Test connection" POST /test`
 *
 * The label may include spaces when wrapped in double quotes; the
 * method is one of `GET` / `POST` / `PUT` / `DELETE`; the path begins
 * with `/`.
 */
export function getActionAnnotation(field: z.ZodTypeAny): ActionAnnotation | null {
  const description = field.description;
  if (typeof description !== 'string') return null;
  const trimmed = description.trimStart();
  if (!trimmed.startsWith(ACTION_FIELD_MARKER)) return null;

  const rest = trimmed.slice(ACTION_FIELD_MARKER.length).trimStart();
  // `"<label>" <METHOD> <path>`
  const match = rest.match(/^"([^"]+)"\s+(GET|POST|PUT|DELETE)\s+(\/\S*)/);
  if (!match) return null;

  const [, label, method, path] = match;
  return { label, method: method as ActionAnnotation['method'], path };
}
