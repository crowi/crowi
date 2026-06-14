/**
 * RFC-0011 §9 — mapping in-process dispatch results into MCP tool
 * results.
 *
 * MCP tool results carry `content` (an array of typed blocks; the model
 * reads `text`) plus optional `structuredContent` (machine-readable
 * data) and an `isError` flag. The helpers here turn the JSON envelope a
 * dispatched route returns into that shape, and turn an `ApiToolError`
 * (non-2xx) into an `isError` result whose text is derived from the API
 * error envelope so the model can recover (e.g. re-fetch on a 409).
 */
import { ApiToolError } from './dispatch';

/** Minimal MCP tool-result shape (subset of the SDK's `CallToolResult`). */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A plain object whose values we want as `structuredContent`. */
type Structured = Record<string, unknown>;

/** Build a success result: a text block plus optional structured data. */
export const okResult = (text: string, structuredContent?: Structured): McpToolResult => ({
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
});

/**
 * Build a success result for a single page/revision read whose primary
 * payload IS the body. Carries `body` in BOTH places (belt-and-suspenders,
 * RFC-0011 §9):
 *
 *  - `content[0].text` = the body — for clients that read the text block.
 *  - `structuredContent` = `{ body, ...meta }` — for clients that prefer
 *    `structuredContent` and hide the text block. Without this, those
 *    clients lose the body entirely (the original bug).
 *
 * The small duplication is acceptable: read tools are single, non-streamed
 * calls. List/search mappers keep using `okResult` — their useful payload
 * already lives in `structuredContent`, so there is nothing to duplicate.
 */
export const okResultWithBody = (body: string, meta: Structured): McpToolResult => ({
  content: [{ type: 'text', text: body }],
  structuredContent: { body, ...meta },
});

/**
 * Build an error result from an `ApiToolError`. The text is the API
 * error envelope's `code` + `message` (RFC-0011 §9) so the model gets a
 * human-readable, recoverable signal. The full body is echoed in
 * `structuredContent` for clients that introspect it.
 */
export const errorResult = (err: ApiToolError): McpToolResult => {
  const envelope = extractErrorEnvelope(err.body);
  const code = envelope.code ?? `HTTP_${err.status}`;
  const message = envelope.message ?? 'The Crowi API rejected the request.';
  return {
    content: [{ type: 'text', text: `Error (${code}): ${message}` }],
    structuredContent: { status: err.status, error: { code, message } },
    isError: true,
  };
};

/**
 * Run a tool body and convert a thrown `ApiToolError` into an `isError`
 * result. Any other throw is rethrown — the SDK turns an uncaught throw
 * into a protocol-level error, which is the right behaviour for genuine
 * bugs (vs. an expected 4xx from the dispatched route).
 */
export const runTool = async (body: () => Promise<McpToolResult>): Promise<McpToolResult> => {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ApiToolError) {
      return errorResult(err);
    }
    throw err;
  }
};

/** Best-effort extraction of `{ error: { code, message } }`. */
const extractErrorEnvelope = (body: unknown): { code?: string; message?: string } => {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error: unknown }).error;
    // Most routes use the nested `{ error: { code, message } }` shape;
    // the rate-limit envelopes use a flat `{ error: 'rate_limited',
    // message }`. Handle both.
    if (error && typeof error === 'object') {
      const e = error as { code?: unknown; message?: unknown };
      return {
        code: typeof e.code === 'string' ? e.code : undefined,
        message: typeof e.message === 'string' ? e.message : undefined,
      };
    }
    if (typeof error === 'string') {
      const message = (body as { message?: unknown }).message;
      return { code: error, message: typeof message === 'string' ? message : undefined };
    }
  }
  return {};
};
