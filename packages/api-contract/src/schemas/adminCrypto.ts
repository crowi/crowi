import { z } from 'zod';

/**
 * Per-(ns, key) status for a sensitive Config entry.
 *
 * - `present`  : whether the row exists in the DB
 * - `encrypted`: when present, whether the stored value is in `enc:v1:` form
 *
 * `(present, encrypted)` of `(true, false)` is exactly the migration target —
 * the value exists but predates encryption.
 */
export const SensitiveConfigEntrySchema = z.object({
  ns: z.string(),
  key: z.string(),
  present: z.boolean(),
  encrypted: z.boolean(),
});
export type SensitiveConfigEntry = z.infer<typeof SensitiveConfigEntrySchema>;

export const CryptoStatusResponseSchema = z.object({
  /** False when CROWI_ENCRYPTION_KEY is not configured. UI should show a setup hint. */
  encryptionConfigured: z.boolean(),
  /** Number of sensitive entries that exist in the DB and are still plaintext. */
  unencryptedCount: z.number().int().min(0),
  /** Number of sensitive entries already encrypted at rest. */
  encryptedCount: z.number().int().min(0),
  entries: z.array(SensitiveConfigEntrySchema),
});
export type CryptoStatusResponse = z.infer<typeof CryptoStatusResponseSchema>;

export const ReencryptResponseSchema = z.object({
  /** Number of rows that were rewritten this run. */
  rewritten: z.number().int().min(0),
  /** Number of rows that were already encrypted (skipped). */
  alreadyEncrypted: z.number().int().min(0),
  /** Number of sensitive registry entries that had no row in the DB. */
  missing: z.number().int().min(0),
});
export type ReencryptResponse = z.infer<typeof ReencryptResponseSchema>;

export const EncryptionNotConfiguredErrorSchema = z.object({
  error: z.object({
    code: z.literal('ENCRYPTION_NOT_CONFIGURED'),
    message: z.string(),
  }),
});
export type EncryptionNotConfiguredError = z.infer<typeof EncryptionNotConfiguredErrorSchema>;
