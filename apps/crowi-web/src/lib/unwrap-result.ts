'use client';

/**
 * Helper to collapse the "if (status === 200) return body … if (status === N)
 * throw …" ladder that ts-rest hooks have to repeat. ~13 hook files share the
 * same shape; the helper keeps each call site declarative without forcing a
 * factory abstraction.
 *
 * Two patterns are supported:
 *
 * 1. Throw on every non-200 status:
 *
 *    return unwrapResult(result, {
 *      ok: (body) => body.page,
 *      errors: {
 *        409: { message: m['errors.conflict'](), ErrorClass: PageRevisionConflictError },
 *        400: m['errors.update_failed'](),
 *        404: { message: m['errors.page_not_found'](), preferLocal: true },
 *      },
 *      fallback: m['errors.update_failed'](),
 *    });
 *
 * 2. Silently fall back to a default value for known statuses (e.g. 401 →
 *    null when the user isn't logged in):
 *
 *    return unwrapResult(result, {
 *      ok: (body) => body.bookmark,
 *      silent: { statuses: [401], value: null },
 *      errors: { 400: m['errors.bookmark_failed']() },
 *      fallback: 'Failed to fetch bookmark',
 *    });
 */

interface ResultLike {
  status: number;
  body: unknown;
}

/**
 * The 200-body type extracted from a ts-rest result union. ts-rest gives
 * `{ status: 200; body: TheSuccessShape; ... } | { status: 400; body: ...; ... } | ...`,
 * so this narrows to just the success arm so `ok` callbacks see the right type.
 */
type SuccessBody<R> = Extract<R, { status: 200 }> extends { body: infer B } ? B : never;

/**
 * Per-status error specifier. A bare string is the per-status fallback
 * message; the wire `body.error.message` (when present) is preferred over
 * it. Pass `{ message, preferLocal: true }` to ignore the wire message,
 * or `{ ErrorClass }` to throw a custom Error subclass.
 */
export type ErrorSpec =
  | string
  | {
      message: string;
      ErrorClass?: new (message: string) => Error;
      /** When true, always throw with `message`, ignoring `body.error.message`. */
      preferLocal?: boolean;
    };

interface UnwrapOptions<TResult extends ResultLike, T, TSilent> {
  /** Extract the success value from a 200 response body. */
  ok: (body: SuccessBody<TResult>) => T;
  /** Per-status error mappings. */
  errors?: Record<number, ErrorSpec>;
  /** Status codes that should resolve to `silent.value` instead of throwing. */
  silent?: { statuses: number[]; value: TSilent };
  /** Error message thrown when no status code matches `errors` or `silent`. */
  fallback: string;
}

/**
 * Pull a wire-level message out of an unknown error body. Two shapes are
 * recognised:
 *   - `{ error: { message } }` — the standard ts-rest contract envelope.
 *   - `{ message }` — flat envelope used by `apiClient.me.*` (predates the
 *     standard wrapping).
 * Anything else returns undefined.
 */
const wireMessage = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const wrapped = (body as { error?: { message?: unknown } }).error?.message;
  if (typeof wrapped === 'string') return wrapped;
  const flat = (body as { message?: unknown }).message;
  if (typeof flat === 'string') return flat;
  return undefined;
};

export function unwrapResult<TResult extends ResultLike, T, TSilent = T>(result: TResult, opts: UnwrapOptions<TResult, T, TSilent>): T | TSilent {
  if (result.status === 200) {
    return opts.ok(result.body as SuccessBody<TResult>);
  }

  if (opts.silent?.statuses.includes(result.status)) {
    return opts.silent.value;
  }

  const spec = opts.errors?.[result.status];
  if (spec !== undefined) {
    const wire = wireMessage(result.body);
    if (typeof spec === 'string') {
      throw new Error(wire || spec);
    }
    const message = spec.preferLocal ? spec.message : wire || spec.message;
    const Ctor = spec.ErrorClass ?? Error;
    throw new Ctor(message);
  }

  throw new Error(opts.fallback);
}
