import { createMiddleware } from 'hono/factory';

/**
 * RFC-0023 §9 — `renderedAst` content negotiation.
 *
 * Reads the `X-Crowi-Ast-Version` request header once, app-wide, and
 * exposes it as a typed Hono context variable (same pattern as
 * `HonoAuthVariables`, `middleware/auth.ts`). The 4 `renderedAst`
 * emitting handlers (getPage / listPages portal / getRevision /
 * preview) consume it through `pickRenderedAstShape`
 * (`util/rendered-ast-negotiation.ts`) — no handler reads the header
 * directly.
 *
 * Mounted on `'*'` right after CORS (`hono/index.ts`) — a cheap
 * app-wide read avoids the "double install on the same prefix" trap
 * the revision handler's doc comment warns about.
 *
 * The header value is a single integer (not a list / not semver). A
 * missing or non-integer value leaves the variable unset, which every
 * consumer treats as "legacy shape" (bare mdast Root, unvalidated).
 */
export const AST_VERSION_HEADER = 'X-Crowi-Ast-Version';

export interface AstNegotiationVariables {
  /** The declared AST wire version, when the request sent a parseable integer. */
  astVersion?: number;
}

export const createAstNegotiation = () =>
  createMiddleware<{ Variables: AstNegotiationVariables }>(async (c, next) => {
    const raw = c.req.header(AST_VERSION_HEADER);
    if (raw !== undefined) {
      const trimmed = raw.trim();
      if (/^\d{1,4}$/.test(trimmed)) {
        c.set('astVersion', Number.parseInt(trimmed, 10));
      }
    }
    await next();
  });
