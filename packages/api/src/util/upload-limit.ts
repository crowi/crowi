/**
 * The single source of truth for the attachment upload size limit, read
 * by `registerAttachmentRoutes` in `hono/handlers/attachment.ts` (as the
 * local `uploadMaxBytes`, closed over by every route handler it
 * registers).
 *
 * `resolveUploadMaxBytes()` reads `CROWI_UPLOAD_MAX_BYTES` and is meant to
 * be called exactly once per `registerAttachmentRoutes` call — once per
 * process in production, and only after `dotenv.config()` has run — with
 * the resolved value fixed for the process lifetime from that point on.
 *
 * The hard ceiling exists because `c.req.parseBody()` buffers the entire
 * multipart body in memory: the resolved value IS the per-upload memory
 * budget (consumption = concurrent uploads × this value), so an operator
 * may only LOWER it. A value above the ceiling is clamped rather than
 * rejected at boot — an operator setting a too-large value almost
 * certainly wants "as large as this server allows", not a crashed
 * process — and `warn` is invoked once to surface the clamp. `env-schema.ts`
 * separately registers `CROWI_UPLOAD_MAX_BYTES` as a taxonomy/format
 * descriptor (malformed-value warning), so this function does not warn a
 * second time for a value that is merely not a positive integer.
 */

export const UPLOAD_MAX_BYTES_CEILING = 50 * 1024 * 1024;

/** Equal to the ceiling — the safe/permissive value when unset or invalid. */
export const UPLOAD_MAX_BYTES_DEFAULT = UPLOAD_MAX_BYTES_CEILING;

const defaultWarn = (message: string): void => {
  console.warn(`[crowi:upload-limit] ${message}`);
};

/**
 * Resolve the process-wide upload size limit from `rawValue` (defaults to
 * `process.env.CROWI_UPLOAD_MAX_BYTES`). Parsing mirrors
 * `image-display-derivative.ts`'s `resolvePositiveIntEnv`: trimmed,
 * digits-only, positive — anything else (missing, non-numeric, zero,
 * negative) falls back to {@link UPLOAD_MAX_BYTES_DEFAULT} silently. A
 * valid value above {@link UPLOAD_MAX_BYTES_CEILING} is clamped to it, and
 * `warn` is called once with a message naming both the rejected value and
 * the ceiling it was clamped to.
 */
export function resolveUploadMaxBytes(
  rawValue: string | undefined = process.env.CROWI_UPLOAD_MAX_BYTES,
  warn: (message: string) => void = defaultWarn,
): number {
  if (rawValue === undefined) return UPLOAD_MAX_BYTES_DEFAULT;

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) return UPLOAD_MAX_BYTES_DEFAULT;

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed <= 0) return UPLOAD_MAX_BYTES_DEFAULT;

  if (parsed > UPLOAD_MAX_BYTES_CEILING) {
    // Log `trimmed` (the raw digit string), not `parsed`: a configured value
    // far outside Number's safe-integer range still parses to *some* finite
    // double, but that double can render very differently from what the
    // operator actually typed (e.g. exponential notation) — the raw string
    // is what they'd need to recognise their own mistake.
    warn(
      `CROWI_UPLOAD_MAX_BYTES=${trimmed} exceeds the ${UPLOAD_MAX_BYTES_CEILING}-byte ceiling (parseBody() buffers the whole upload in memory, so this value is a memory budget, not just a policy number) — using ${UPLOAD_MAX_BYTES_CEILING}.`,
    );
    return UPLOAD_MAX_BYTES_CEILING;
  }

  return parsed;
}
