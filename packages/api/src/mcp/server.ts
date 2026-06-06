/**
 * RFC-0011 §7 — per-request MCP server factory + data-driven tool table.
 *
 * `buildMcpServer(ctx)` builds a fresh `McpServer` per request (stateless
 * transport, RFC-0011 §4). The server registers the static tool catalog,
 * but every tool closes over the request's `dispatch` (which carries the
 * caller's `Authorization`), so tool calls run with the caller's identity
 * and inherit the dispatched route's scope enforcement (RFC-0011 §5.2).
 *
 * The tool catalog is **data-driven**: each tool is a `ToolDescriptor`
 * row `{ name, method, path, ... }`, so adding a tool is one row, not a
 * new code path (RFC-0011 §8). Three request shapes are supported:
 *   - **query** tools (GET): the validated input becomes the query bag.
 *   - **body** tools (POST/PUT/DELETE): the validated input becomes the
 *     JSON body.
 *   - **path-param** tools: one or more input fields are spliced into the
 *     route path (e.g. `/pages/{page_id}/revisions`) and the remainder
 *     becomes the query / body.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';

import type { Dispatch } from './dispatch';
import { type McpToolResult, okResult, runTool } from './result';
import { pageTools } from './tools/page';
import { searchTools } from './tools/search';

/** Server identity advertised to MCP clients (`initialize` response). */
const SERVER_INFO = {
  name: 'crowi',
  version: '1.0.0',
} as const;

/** How a tool's validated input is turned into a dispatch request. */
export type ToolKind = 'query' | 'body';

/**
 * A single tool definition. The dispatched route is `method path` (bare,
 * no `/api/v2`); the route enforces scope, so the `scope` field here is
 * documentation only (it is never re-checked in the MCP layer).
 */
export interface ToolDescriptor {
  /** MCP tool name, `crowi_<verb>_<noun>`. */
  name: string;
  /** Human + model-facing description. Documents revision_id etc. */
  description: string;
  /** HTTP method of the dispatched route. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Route path with optional `{param}` placeholders filled from the
   * input (e.g. `/pages/{page_id}/revisions`). Placeholder fields are
   * removed from the query / body after substitution.
   */
  path: string;
  /** Input schema shape passed to `registerTool` for boundary validation. */
  schema: ZodRawShape;
  /**
   * Whether the non-path input becomes the query string (GET) or the
   * JSON body (POST/PUT/DELETE).
   */
  kind: ToolKind;
  /** Scope the dispatched route requires (documentation only). */
  scope: string;
  /** Map the dispatched route's JSON result into an MCP tool result. */
  resultMapper: (body: unknown) => McpToolResult;
}

/** Names of `{param}` placeholders in a path template. */
const pathParamNames = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

/**
 * Substitute `{param}` placeholders in `path` from `input`, returning the
 * concrete path plus the remaining (non-path) input fields.
 */
const splicePathParams = (path: string, input: Record<string, unknown>): { path: string; rest: Record<string, unknown> } => {
  const names = pathParamNames(path);
  if (names.length === 0) return { path, rest: input };

  let concrete = path;
  const rest = { ...input };
  for (const name of names) {
    const value = rest[name];
    concrete = concrete.replace(`{${name}}`, encodeURIComponent(String(value ?? '')));
    delete rest[name];
  }
  return { path: concrete, rest };
};

/** Context captured per request and closed over by every tool. */
export interface McpServerContext {
  dispatch: Dispatch;
}

/**
 * Build a per-request `McpServer` with the full tool catalog registered.
 * Stateless: a fresh server is connected to a fresh transport per request
 * by `attachMcp`.
 */
export const buildMcpServer = (ctx: McpServerContext): McpServer => {
  const server = new McpServer(SERVER_INFO);
  const descriptors: ToolDescriptor[] = [...pageTools, ...searchTools];

  for (const tool of descriptors) {
    // The SDK validates `args` against `tool.schema` before invoking the
    // callback, so `args` is the parsed input — invalid input never
    // reaches here (it is rejected at the MCP boundary as `isError`,
    // RFC §6). The handler return type (`McpToolResult`) is structurally
    // a `CallToolResult` but lacks the SDK type's `[x: string]: unknown`
    // index signature, so we cast at the registration boundary.
    const handler = async (args: Record<string, unknown>): Promise<McpToolResult> =>
      runTool(async () => {
        const { path, rest } = splicePathParams(tool.path, args ?? {});
        const init = tool.kind === 'query' ? { query: rest as Record<string, string | number | boolean | undefined | null> } : { json: rest };
        const body = await ctx.dispatch(tool.method, path, init);
        return tool.resultMapper(body);
      });

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      handler as Parameters<typeof server.registerTool>[2],
    );
  }

  return server;
};

/** Re-export the result helper so tool tables can build success results. */
export { okResult };
