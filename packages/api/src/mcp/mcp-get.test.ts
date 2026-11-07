/**
 * `GET` / `HEAD /api/mcp` answer 405 immediately instead of opening the
 * server-to-client SSE stream (a held-open stream pins memory per client).
 */

import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UserDocument } from 'src/models/user';
import { app, crowi, Fixture } from 'src/test/setup';
import request from 'supertest';

describe('MCP GET /api/mcp', () => {
  const USER_EMAIL = 'mcp-get-tester@example.com';
  let user: UserDocument;
  let pat: string;

  beforeAll(async () => {
    const User = crowi.model('User');
    const [created] = await Fixture.generate('User', [{ name: 'MCP Get Tester', username: 'mcpGetTester', email: USER_EMAIL }]);
    created.status = User.STATUS_ACTIVE;
    await created.save();
    user = created as UserDocument;

    const PersonalAccessToken = crowi.model('PersonalAccessToken');
    const { token, tokenHash } = PersonalAccessToken.generateToken();
    await PersonalAccessToken.create({ tokenHash, userId: user._id, name: `mcp-get-test-${Date.now()}`, scopes: ['write'] });
    pat = token;
  });

  afterAll(async () => {
    await crowi.model('User').deleteMany({ email: USER_EMAIL });
  });

  it('answers GET with 405, Allow and a JSON-RPC error', async () => {
    const res = await request(app).get('/api/mcp').set('Authorization', `Bearer ${pat}`).set('Accept', 'text/event-stream').timeout(5000);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST, DELETE');
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  it('answers HEAD with 405 and Allow', async () => {
    const res = await request(app).head('/api/mcp').set('Authorization', `Bearer ${pat}`).timeout(5000);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST, DELETE');
  });

  it('keeps answering an unauthenticated GET with 401', async () => {
    const res = await request(app).get('/api/mcp').set('Accept', 'text/event-stream').timeout(5000);
    expect(res.status).toBe(401);
  });

  it('keeps serving POST tools/list', async () => {
    const res = await request(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${pat}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const line = String(res.headers['content-type']).includes('text/event-stream') ? res.text.split('\n').find((l) => l.startsWith('data:')) : undefined;
    const rpc = line ? JSON.parse(line.slice('data:'.length).trim()) : res.body;
    expect(Array.isArray(rpc.result.tools)).toBe(true);
    expect(rpc.result.tools.length).toBeGreaterThan(0);
  });

  it('lets the official SDK client connect and list tools without transport errors', async () => {
    const { port } = app.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${pat}` } },
    });
    const onerror = jest.fn();
    transport.onerror = onerror;
    const client = new Client({ name: 'mcp-get-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(onerror).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
