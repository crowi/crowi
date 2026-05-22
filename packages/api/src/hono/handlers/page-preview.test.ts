import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const createTestUser = async () => {
  const User = crowi.model('User');
  const [user] = await Fixture.generate('User', [
    {
      name: 'Preview Tester',
      username: 'previewTester',
      email: 'preview-tester@example.com',
    },
  ]);
  user.status = User.STATUS_ACTIVE;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

describe('Routes /api/v2/pages/preview (Hono previewPage)', () => {
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await createTestUser());
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).post('/api/v2/pages/preview').send({ body: '# hello' }).set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('renders an empty body to an empty mdast root', async () => {
    const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body: '' });

    expect(res.status).toBe(200);
    expect(res.body.renderedAst).toBeDefined();
    expect(res.body.renderedAst.type).toBe('root');
    expect(Array.isArray(res.body.renderedAst.children)).toBe(true);
    expect(res.body.renderedAst.children).toHaveLength(0);
  });

  it('renders a heading to a heading mdast node', async () => {
    const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body: '# Hello world' });

    expect(res.status).toBe(200);
    const ast = res.body.renderedAst as { children: Array<{ type: string; depth?: number; children?: Array<{ value?: string }> }> };
    expect(ast.children.length).toBeGreaterThan(0);
    const heading = ast.children[0];
    expect(heading.type).toBe('heading');
    expect(heading.depth).toBe(1);
    // The heading text bubbles up through a text child node.
    expect(heading.children?.[0]?.value).toBe('Hello world');
  });

  it('runs the same pipeline plugins as the save path (heading anchor stamping)', async () => {
    const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body: '## Some Section' });

    expect(res.status).toBe(200);
    const ast = res.body.renderedAst as { children: Array<{ type: string; data?: { hProperties?: { id?: string } } }> };
    const heading = ast.children[0];
    expect(heading.type).toBe('heading');
    // Core heading-anchor transform stamps `data.hProperties.id` via
    // github-slugger. The exact slug must match what the save-path
    // would have produced for the same text, otherwise edit preview
    // and page show would disagree on anchor ids.
    expect(heading.data?.hProperties?.id).toBe('some-section');
  });

  it('strips parser `position` metadata so the response payload stays compact', async () => {
    const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body: '# Heading\n\nparagraph' });

    expect(res.status).toBe(200);
    const ast = res.body.renderedAst as { children: Array<Record<string, unknown>> };
    for (const node of ast.children) {
      expect(node.position).toBeUndefined();
    }
  });

  it('injects `data-source-line` on every top-level node for editor → preview scroll sync', async () => {
    // The body has three top-level blocks: heading (line 1), paragraph
    // (line 3), code fence (starts line 5). Editor scroll sync reads
    // these `data-source-line` attrs off the rendered preview DOM —
    // they have to ride the serialised mdast across the wire.
    const body = '# H1\n\nparagraph\n\n```\ncode\n```\n';
    const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

    expect(res.status).toBe(200);
    const ast = res.body.renderedAst as {
      children: Array<{ type: string; data?: { hProperties?: { 'data-source-line'?: number } } }>;
    };
    expect(ast.children.length).toBeGreaterThanOrEqual(3);
    const lines = ast.children.map((c) => c.data?.hProperties?.['data-source-line']);
    expect(lines[0]).toBe(1); // heading
    expect(lines[1]).toBe(3); // paragraph
    expect(lines[2]).toBe(5); // code fence opens at line 5
  });
});
