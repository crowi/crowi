import { CURRENT_AST_VERSION } from '@crowi/api-contract';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { app } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

/**
 * RFC-0023 §9 — handler-level content negotiation across the 4
 * `renderedAst` emitting endpoints (getPage / listPages / getRevision /
 * preview): legacy (declaration-less) requests keep receiving the bare
 * Root byte-shape, `X-Crowi-Ast-Version: 1` requests receive the
 * envelope, every response varies on the header, and the CORS layer
 * allow-lists it.
 */

const AST_HEADER = 'X-Crowi-Ast-Version';
const PAGE_BODY = ['# Negotiated Page', '', 'Some text.', '', '```ts', 'const a = 1;', '```'].join('\n');

interface EnvelopeShape {
  astVersion: number;
  root: { type: string; children: Array<{ type: string; lang?: string; data?: { tokens?: unknown[]; hProperties?: Record<string, unknown> } }> };
}

describe('renderedAst content negotiation (RFC-0023 §9)', () => {
  let accessToken: string;
  let pageId: string;
  let revisionId: string;

  beforeAll(async () => {
    const { accessToken: token } = await createTestUser({ name: 'Ast Nego', username: 'astNego', email: 'ast-nego@example.com' });
    accessToken = token;
    const page = await createPageViaApi(accessToken, '/ast-nego/page', PAGE_BODY);
    pageId = page._id;
    const res = await request(app).get('/api/v2/pages').query({ page_id: pageId }).set(authHeaders(accessToken));
    revisionId = res.body.page.revision._id;
  });

  describe('GET /pages (getPage)', () => {
    it('declaration-less request → bare Root (no astVersion), fresh-verbatim artifact key, Vary set', async () => {
      const res = await request(app).get('/api/v2/pages').query({ page_id: pageId }).set(authHeaders(accessToken));
      expect(res.status).toBe(200);
      const ast = res.body.page.revision.renderedAst;
      expect(ast.type).toBe('root');
      expect(ast.astVersion).toBeUndefined();
      // The stored producer html node (shiki fence) arrives verbatim,
      // sidecar included — the legacy branch is unvalidated passthrough.
      const htmlNode = (ast.children as Array<{ type: string; data?: Record<string, unknown> }>).find((c) => c.type === 'html');
      expect(htmlNode).toBeDefined();
      expect(htmlNode?.data?.crowiCode).toBeDefined();
      // §14 — a fresh verbatim response keys on the stable pipeline version.
      expect(res.body.page.revision.renderedAstArtifactKey).toBe(RENDERER_PIPELINE_VERSION);
      expect(res.headers.vary).toContain(AST_HEADER);
    });

    it('X-Crowi-Ast-Version: 1 → envelope with the shiki fence projected to a tokens-carrying code node', async () => {
      const res = await request(app).get('/api/v2/pages').query({ page_id: pageId }).set(authHeaders(accessToken)).set(AST_HEADER, '1');
      expect(res.status).toBe(200);
      const envelope = res.body.page.revision.renderedAst as EnvelopeShape;
      expect(envelope.astVersion).toBe(CURRENT_AST_VERSION);
      expect(envelope.root.type).toBe('root');
      const code = envelope.root.children.find((c) => c.type === 'code');
      expect(code?.lang).toBe('ts');
      expect(Array.isArray(code?.data?.tokens)).toBe(true);
      expect(res.headers.vary).toContain(AST_HEADER);
    });

    it('an unsupported declared version behaves like no declaration', async () => {
      const res = await request(app).get('/api/v2/pages').query({ page_id: pageId }).set(authHeaders(accessToken)).set(AST_HEADER, '99');
      expect(res.status).toBe(200);
      expect(res.body.page.revision.renderedAst.type).toBe('root');
      expect(res.body.page.revision.renderedAst.astVersion).toBeUndefined();
    });
  });

  describe('GET /pages/list (listPages — portal document path)', () => {
    it('sets Vary on the list response (the portal document is the only renderedAst carrier)', async () => {
      const res = await request(app).get('/api/v2/pages/list').query({ path: '/ast-nego/' }).set(authHeaders(accessToken)).set(AST_HEADER, '1');
      expect(res.status).toBe(200);
      expect(res.headers.vary).toContain(AST_HEADER);
    });
  });

  describe('GET /pages/revisions/:id (getRevision)', () => {
    it('declaration-less → bare Root + Vary; v1 → envelope + artifact key', async () => {
      const legacy = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(accessToken));
      expect(legacy.status).toBe(200);
      expect(legacy.body.revision.renderedAst.type).toBe('root');
      expect(legacy.headers.vary).toContain(AST_HEADER);

      const v1 = await request(app).get(`/api/v2/pages/revisions/${revisionId}`).set(authHeaders(accessToken)).set(AST_HEADER, '1');
      expect(v1.status).toBe(200);
      const envelope = v1.body.revision.renderedAst as EnvelopeShape;
      expect(envelope.astVersion).toBe(CURRENT_AST_VERSION);
      expect(envelope.root.type).toBe('root');
      expect(v1.body.revision.renderedAstArtifactKey).toBe(RENDERER_PIPELINE_VERSION);
    });
  });

  describe('POST /pages/preview', () => {
    it('goes through the same chokepoint: v1 → envelope with data-source-line hProperties preserved; artifact key is a per-response nonce', async () => {
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).set(AST_HEADER, '1').send({ body: '# Title\n\ntext line' });
      expect(res.status).toBe(200);
      const envelope = res.body.renderedAst as EnvelopeShape;
      expect(envelope.astVersion).toBe(CURRENT_AST_VERSION);
      // §4 — preview's scroll-sync anchors survive the walker.
      const heading = envelope.root.children[0];
      expect(heading.data?.hProperties?.['data-source-line']).toBe(1);
      expect(res.headers.vary).toContain(AST_HEADER);
      expect(typeof res.body.renderedAstArtifactKey).toBe('string');

      const res2 = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).set(AST_HEADER, '1').send({ body: '# Title\n\ntext line' });
      expect(res2.body.renderedAstArtifactKey).not.toBe(res.body.renderedAstArtifactKey);
    });

    it('declaration-less preview keeps the bare Root shape', async () => {
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body: '# Title' });
      expect(res.status).toBe(200);
      expect(res.body.renderedAst.type).toBe('root');
      expect(res.body.renderedAst.astVersion).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('preflight allow-lists X-Crowi-Ast-Version', async () => {
      const res = await request(app)
        .options('/api/v2/pages')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', AST_HEADER);
      const allowed = res.headers['access-control-allow-headers'] ?? '';
      expect(allowed.toLowerCase()).toContain(AST_HEADER.toLowerCase());
    });
  });
});
