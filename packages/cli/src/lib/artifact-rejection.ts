import { z } from 'zod';

/**
 * RFC-0020 §J-1 — the shape `formatArtifactRejection` requires before it
 * will format a response body as an artifact rejection. Deliberately
 * `reason` / `ruleId` as bare `z.string()` rather than the server's closed
 * `ArtifactIngestRejectionReasonSchema` enum / `ruleId` regex
 * (`@crowi/api-contract`'s `ArtifactWriteRejectionSchema`): the CLI reads
 * responses leniently everywhere else (`lib/http.ts`'s doc comment), and a
 * newer server's new reason/rule would otherwise fail this schema and fall
 * back to the generic message instead of showing the (still meaningful)
 * reason/ruleId text a strict enum can't anticipate.
 */
const ArtifactRejectionEnvelopeSchema = z.object({
  error: z.object({
    code: z.literal('ARTIFACT_WRITE_REJECTED'),
    reason: z.string(),
    ruleId: z.string(),
    message: z.string(),
    target: z.string().optional(),
  }),
});

/**
 * Format an artifact write-rejection body into a single CLI-ready message,
 * or `null` when `body` is not a genuine, COMPLETE artifact envelope.
 *
 * Requiring every field (not just `error.code === 'ARTIFACT_WRITE_REJECTED'`)
 * matters the same way it does for the MCP side (`mcp/result.ts`'s
 * `errorResult`, which validates the in-process response against
 * `ArtifactWriteRejectionSchema` directly — the CLI cannot reuse that strict
 * schema here since it talks HTTP, not in-process, and a newer server is a
 * real possibility): a front proxy can return a partial lookalike body with
 * just a `code`, and formatting that would print `undefined` for the missing
 * fields instead of falling through to the generic error message
 * `parseResponse` already produces. Mirrors the full-envelope re-validation
 * `commands/attach.ts:129-149` already does for the same reason on a
 * different envelope.
 */
export function formatArtifactRejection(body: unknown): string | null {
  const parsed = ArtifactRejectionEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;

  const { message, ruleId, reason, target } = parsed.data.error;
  const base = `${message} (${ruleId} / ${reason})`;
  return target === undefined ? base : `${base}\ntarget: ${target}`;
}
