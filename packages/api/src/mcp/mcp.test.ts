/**
 * RFC-0011 — in-repo smoke test for the built-in MCP server.
 *
 * Drives the live `/mcp` route through the same Hono app the production
 * server serves (`buildHonoApp(crowi)` via the shared test harness), so
 * the JSON-RPC envelope, `createJwtAuth`, per-tool scope enforcement, and
 * in-process dispatch are all exercised end-to-end. Covers:
 *
 *   (a) `tools/list` returns all 13 tools.
 *   (b) `crowi_get_page` returns a real page's body.
 *   (c) a read-only (`pages:read`) token calling a write tool gets the
 *       dispatched route's 403 INSUFFICIENT_SCOPE mapped to `isError`.
 *   (d) a missing token is rejected by the `/mcp` auth gate (401).
 */
import { app, crowi, Fixture } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

/**
 * Send a JSON-RPC request to `/mcp`. The `@hono/mcp` transport replies
 * either as `application/json` or as a single SSE `data:` frame
 * (`text/event-stream`) depending on the client `Accept`; we request
 * both and parse whichever comes back.
 */
const callMcp = async (token: string | null, payload: unknown) => {
  // No `Host` pin needed: DNS-rebinding protection is off (the endpoint is
  // Bearer-gated), so supertest's own Host header is accepted.
  let req = request(app).post('/api/v2/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream');
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  const res = await req.send(payload as object);
  return res;
};

/** Parse a JSON-RPC result whether it came back as JSON or an SSE frame. */
const parseRpc = (res: request.Response): { result?: Record<string, unknown>; error?: unknown } => {
  const contentType = String(res.headers['content-type'] ?? '');
  if (contentType.includes('text/event-stream')) {
    // Single `data: {...}` line in the SSE frame.
    const line = res.text.split('\n').find((l) => l.startsWith('data:'));
    if (!line) throw new Error(`No SSE data frame in response: ${res.text}`);
    return JSON.parse(line.slice('data:'.length).trim());
  }
  return res.body;
};

const createTestUser = async (info: { name: string; username: string; email: string }): Promise<UserDocument> => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [info]);
  user.status = User.STATUS_ACTIVE;
  await user.save();
  return user as UserDocument;
};

describe('MCP server (/mcp)', () => {
  const PATH_PREFIX = '/mcp-smoke-test/';
  let user: UserDocument;
  let webToken: string;
  let jwtUtil: ReturnType<typeof createJwtUtil>;
  let pageId: string;
  const pageBody = '# MCP smoke page\n\nThis is the body the MCP get_page tool should return.';

  beforeAll(async () => {
    jwtUtil = createJwtUtil(crowi);
    user = await createTestUser({ name: 'MCP Tester', username: 'mcpTester', email: 'mcp-tester@example.com' });
    webToken = jwtUtil.generateTokens(user).accessToken;

    // Seed a real page via the existing create route so the read tool has
    // something to fetch.
    const Page = crowi.model('Page');
    const created = await Page.createPage(`${PATH_PREFIX}home`, pageBody, user, { grant: Page.GRANT_PUBLIC });
    pageId = created._id.toString();
  });

  afterAll(async () => {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');
    const filter = { path: { $regex: `^${PATH_PREFIX}` } };
    await Promise.all([Page.deleteMany(filter), Revision.deleteMany(filter)]);
    await crowi.model('User').deleteMany({ email: 'mcp-tester@example.com' });
  });

  const oauthToken = (scopes: string[]) => jwtUtil.signOauthAccessToken({ user, scopes, clientId: 'crowi-cli' });

  it('rejects an unauthenticated request (no token) with 401', async () => {
    const res = await callMcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('lists all 13 tools via tools/list', async () => {
    const res = await callMcp(webToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const rpc = parseRpc(res);
    const tools = (rpc.result?.tools ?? []) as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'crowi_autocomplete_pages',
        'crowi_create_page',
        'crowi_delete_page',
        'crowi_get_backlinks',
        'crowi_get_page',
        'crowi_get_page_history',
        'crowi_get_revision',
        'crowi_list_child_pages',
        'crowi_list_pages',
        'crowi_rename_page',
        'crowi_revert_page',
        'crowi_search_pages',
        'crowi_update_page',
      ].sort(),
    );
    expect(names).toHaveLength(13);
  });

  it('crowi_get_page returns the real page body as text content', async () => {
    const res = await callMcp(webToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'crowi_get_page', arguments: { page_id: pageId } },
    });
    expect(res.status).toBe(200);
    const rpc = parseRpc(res);
    const result = rpc.result as { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('MCP smoke page');
    expect(result.structuredContent?.page_id).toBe(pageId);
  });

  it('maps a read-only token writing a page to an isError result (403 INSUFFICIENT_SCOPE)', async () => {
    const readOnly = oauthToken(['pages:read']);
    const res = await callMcp(readOnly, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'crowi_create_page', arguments: { path: `${PATH_PREFIX}should-fail`, body: '# nope' } },
    });
    expect(res.status).toBe(200); // JSON-RPC envelope is 200; the tool result carries isError.
    const rpc = parseRpc(res);
    const result = rpc.result as { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: { status?: number } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe(403);
    expect(result.content[0].text).toContain('INSUFFICIENT_SCOPE');

    // The page must not have been created.
    const Page = crowi.model('Page');
    const leaked = await Page.findOne({ path: `${PATH_PREFIX}should-fail` });
    expect(leaked).toBeNull();
  });

  it('a read-only token can still call a read tool', async () => {
    const readOnly = oauthToken(['pages:read']);
    const res = await callMcp(readOnly, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'crowi_get_page', arguments: { page_id: pageId } },
    });
    expect(res.status).toBe(200);
    const rpc = parseRpc(res);
    const result = rpc.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('MCP smoke page');
  });
});
