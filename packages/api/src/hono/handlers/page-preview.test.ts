import { PreviewPageRequestSchema } from '@crowi/api-contract';
import type { CodeBlockRenderer, PluginLogger } from '@crowi/plugin-api';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import request from 'supertest';

describe('Routes /api/v2/pages/preview (Hono previewPage)', () => {
  let accessToken: string;
  let accessTokenUserId: string;

  beforeAll(async () => {
    const { accessToken: token, user } = await createTestUser({ name: 'Preview Tester', username: 'previewTester', email: 'preview-tester@example.com' });
    accessToken = token;
    accessTokenUserId = user._id.toString();
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

  // feature-page-link-space-paths Phase 1 — narrow parity claim: `processor.parse(body)`
  // (pipeline.ts:320) is a single mode-independent step run for both preview
  // (`mode: 'view'`, no pageId) and save (`mode: 'save'`, pageId set) — see
  // page-preview.ts vs `Revision.prepareRevision`. None of the core
  // transforms (`buildCorePlugins`) rewrite an ordinary link's `url`, so the
  // parsed `link` node is identical either way for `%20` / `+` / `<...>`
  // destinations. This does NOT claim the full rendered output (or backlink
  // detection) is identical between preview and save — plugin dispatch,
  // mention resolution, and `<a>` vs Next `<Link>` rendering all differ by
  // mode (see the spec's "設計の主な判断" note).
  it('parses %20 / + / <...> link destinations to the same mdast `url` the save path would produce (link-node parse-stage parity only)', async () => {
    const body = '[a](/a%20b) [b](/a+b) [c](</a c>)';
    const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

    expect(res.status).toBe(200);
    const ast = res.body.renderedAst as { children: Array<{ children: Array<{ type: string; url?: string }> }> };
    const links = ast.children[0].children.filter((c) => c.type === 'link');
    expect(links.map((l) => l.url)).toEqual(['/a%20b', '/a+b', '/a c']);
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

  // feature-plugin-renderer-mermaid spec §6/§7 — `Renderer.run`'s `options`
  // gained a required `actor` field and an optional `signal`; this handler
  // is the one call site that also needs the abort signal (so a
  // superseded preview request's queued admission-control job can be
  // dropped, spec §6's AbortSignal-terminates-queued-jobs behaviour).
  // `crowi.getRenderer()` returns a stable singleton (`Crowi.getRenderer`
  // doc comment), so spying on its `run` method directly observes the
  // real call this handler makes.
  it('passes actor: { kind: "user", userId } (the authenticated caller) and the request AbortSignal to renderer.run()', async () => {
    const renderer = crowi.getRenderer();
    const spy = jest.spyOn(renderer, 'run');
    try {
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body: '# hello' });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      const [, options] = spy.mock.calls[0] ?? [];
      expect(options?.actor).toEqual({ kind: 'user', userId: accessTokenUserId });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });

  // feature-plugin-renderer-mermaid spec §7 — editor preview parity for
  // `previewPolicy: 'server-render'` code-block registrations (Mermaid in
  // production; a fixture renderer here so this suite stays independent
  // of the real @crowi/plugin-renderer-mermaid child-process pool).
  describe('previewPolicy:"server-render" dispatch (spec §7)', () => {
    const PLUGIN = '@crowi/plugin-fixture-page-preview';
    const silentLogger: PluginLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

    it('server-renders a previewPolicy:"server-render" fence with no pageId and writes nothing to PluginRenderCache', async () => {
      const renderer: CodeBlockRenderer = {
        cacheVersion: 1,
        previewPolicy: 'server-render',
        render: (info) => ({
          html: `<img class="diagram-embed mermaid-embed" alt="d" src="data:image/svg+xml;base64,${Buffer.from(info.source).toString('base64')}">`,
        }),
      };
      crowi.getRenderer().registry.addCodeBlockRenderer('preview-server-render-fixture', renderer, PLUGIN, silentLogger);

      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const before = await PluginRenderCache.countDocuments({}).exec();

      const body = ['```preview-server-render-fixture', 'flowchart TD', '  A --> B', '```'].join('\n');
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

      expect(res.status).toBe(200);
      const ast = res.body.renderedAst as { children: Array<{ type: string; value?: string }> };
      const node = ast.children[0];
      expect(node.type).toBe('html');
      expect(node.value).toContain('<img class="diagram-embed mermaid-embed"');
      // Scroll-sync anchor embedded directly into the HTML string (the
      // fence starts on line 1, spec §7 item 6).
      expect(node.value).toContain('data-source-line="1"');

      const after = await PluginRenderCache.countDocuments({}).exec();
      expect(after).toBe(before);
    });

    it('leaves a default-policy (PlantUML-shaped) fence untouched with no pageId — render() is never called', async () => {
      const renderSpy = jest.fn(() => ({ html: '<div>should never appear in preview</div>' }));
      const renderer: CodeBlockRenderer = { cacheVersion: 1, render: renderSpy };
      crowi.getRenderer().registry.addCodeBlockRenderer('preview-default-policy-fixture', renderer, PLUGIN, silentLogger);

      const body = ['```preview-default-policy-fixture', '@startuml', 'A -> B', '@enduml', '```'].join('\n');
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

      expect(res.status).toBe(200);
      const ast = res.body.renderedAst as { children: Array<{ type: string; lang?: string }> };
      expect(ast.children[0].type).toBe('code');
      expect(ast.children[0].lang).toBe('preview-default-policy-fixture');
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('an embedded tag and a bare URL alongside a server-render fence still generate zero I/O for the tag/URL (no pageId to key an embed-cache row against)', async () => {
      const embedSpy = jest.fn();
      crowi.getRenderer().registry.addEmbedTag(
        'preview-embed-fixture',
        {
          cacheVersion: 1,
          render: () => {
            embedSpy();
            return { html: '<div>embed should never appear</div>' };
          },
        },
        PLUGIN,
        silentLogger,
      );

      const body = ['@[preview-embed-fixture](http://example.com)', '', 'https://example.com'].join('\n');
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

      expect(res.status).toBe(200);
      expect(embedSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain('embed should never appear');
    });

    it('preview payload/latency measurement gate (spec §7 residual risk): 50 diagrams (~60KB html each) stay well under the 20s client fetch timeout', async () => {
      const bigSvgDataUrl = `data:image/svg+xml;base64,${Buffer.from(`<svg>${'x'.repeat(60 * 1024)}</svg>`).toString('base64')}`;
      const renderer: CodeBlockRenderer = {
        cacheVersion: 1,
        previewPolicy: 'server-render',
        admissionControl: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 },
        render: () => ({ html: `<img class="diagram-embed" alt="d" src="${bigSvgDataUrl}">`, ttlSec: 3600 }),
      };
      crowi.getRenderer().registry.addCodeBlockRenderer('preview-load-fixture', renderer, PLUGIN, silentLogger);

      const oneDiagram = ['```preview-load-fixture', 'flowchart TD', '  A --> B', '```', ''].join('\n');
      const body = Array.from({ length: 50 }, () => oneDiagram).join('\n');

      const start = Date.now();
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });
      const elapsedMs = Date.now() - start;
      const payloadBytes = Buffer.byteLength(JSON.stringify(res.body), 'utf8');

      expect(res.status).toBe(200);
      const ast = res.body.renderedAst as { children: unknown[] };
      expect(ast.children).toHaveLength(50);
      // This synchronous fixture renderer resolves in effectively 0ms per
      // call, so what this gate actually measures is dispatch/admission
      // bookkeeping + response-serialization overhead for a 50-diagram /
      // ~4MB payload — NOT real Mermaid child-process render latency
      // (which the `real-plugin integration through the HTTP route`
      // describe block below exercises, for one real diagram, and which
      // `mermaid.e2e.test.ts` / the Phase 0 spike separately time-bound
      // per-diagram). packages/web/src/lib/fetch-timeout.ts:13's 20s
      // client fetch timeout budget therefore needs to cover THIS
      // pipeline/payload overhead PLUS N × (real per-diagram render time
      // under the admission concurrency cap) — this gate only bounds the
      // former, with a >2x margin against the 20s ceiling, so pipeline
      // overhead alone stays a non-issue; the residual risk spec §7 item 7
      // calls out is specifically about the LATTER term, which is outside
      // what a synchronous fixture can measure.
      expect(elapsedMs).toBeLessThan(8_000);
      // Recorded for visibility — the AC asks the measured numbers to be
      // captured, not just gated.
      // eslint-disable-next-line no-console
      console.info(`[preview latency gate] 50 diagrams (~60KB html each): elapsed=${elapsedMs}ms payload=${payloadBytes} bytes`);
    }, 15_000);

    it('PreviewPageRequestSchema.body (spec §7 item 13 — no preview-only body-size cap) has no .max(), independent of any HTTP/render round trip', () => {
      // This is the actual invariant under test — a preview-only body
      // ceiling would break legitimate large pages the moment their editor
      // opens, which is why none was added — checked directly against the
      // schema (no HTTP, no markdown parsing, no CI-load-dependent timing).
      // Previously combined with the E2E round trip below into one test
      // with a 15s timeout; that combination flaked in CI (confirmed via
      // the flake-report classifier's own solo-rerun: this suite passes
      // standalone, so it was CI-load timing, not a real regression) —
      // split so this half can never be timing-sensitive at all.
      const body = 'x'.repeat(5 * 1024 * 1024); // 5MB, comfortably past any real page
      expect(PreviewPageRequestSchema.safeParse({ body }).success).toBe(true);
    });

    it('a plain-markdown body far larger than any single saved page today still previews with 200 (spec §7 item 13 — end-to-end HTTP/render round trip)', async () => {
      // The schema-level invariant (no size cap) is proven above without
      // any HTTP/render latency in the loop. This test additionally proves
      // the full pipeline (HTTP + markdown parsing + AST serialization)
      // actually accepts and processes a real large body — genuine
      // end-to-end latency, so it uses the suite's global 60s timeout
      // (`jest.setTimeout(60000)`, src/test/setup.ts) instead of a
      // tighter per-test override; this pipeline work is normally well
      // under a second (see the sibling 50-diagram gate's `elapsed`
      // logging above) but the earlier 15s override still flaked under
      // CI/sibling-suite load despite that headroom.
      const paragraph = `${'lorem ipsum dolor sit amet '.repeat(200)}\n\n`;
      const body = paragraph.repeat(600); // ~3.2MB
      expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(3 * 1024 * 1024);

      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

      expect(res.status).toBe(200);
      const ast = res.body.renderedAst as { children: unknown[] };
      expect(ast.children.length).toBeGreaterThan(0);
    });

    it('POST /pages/preview returns 429 with Retry-After once the per-user rate limit (600 req/min) is exceeded', async () => {
      const { accessToken: rateLimitedToken } = await createTestUser({
        name: 'Preview Rate Limited',
        username: 'previewRateLimitedUser',
        email: 'preview-ratelimit@example.com',
      });

      // The limiter uses a fixed 60s window (`floor(now / windowMs)`, same
      // as autocomplete.test.ts's rate-limit test documents). Firing only
      // budget+5 (605) SEQUENTIAL requests — this test's previous shape —
      // is flaky on exactly that boundary-straddle: a slow CI run can
      // straddle a window mid-burst, resetting the count before it ever
      // exceeds the budget in either window. autocomplete's rate-limit test
      // dodges this by firing 2*budget+1 (121) requests fully CONCURRENTLY:
      // by pigeonhole, a burst that spans at most two windows must land
      // >budget hits in one of them, wherever the boundary falls, regardless
      // of timing. Preview's budget is 10x larger (600), so this fires the
      // same 2*budget+1 total, in size-50 concurrent batches.
      //
      // Batching is a SEPARATE concern from `app` being a shared listening
      // server (`src/test/setup.ts` — feature-test-harness-shared-server):
      // even against one shared server, each `request(app)` call still
      // opens its OWN TCP connection (superagent doesn't pool/keep-alive),
      // so firing all 1201 fully concurrently would still open 1201
      // simultaneous sockets against that one server — comfortably above
      // typical OS ephemeral-port/backlog limits, and the exact shape of
      // the `connect ETIMEDOUT` flake this test used to hit (many
      // simultaneous fresh listen/connect/close cycles under a 5-worker
      // parallel run, back when this file also stood up its own local
      // `http.Server`, via `createServer(...)` + `.listen(0)` — see `app`'s
      // doc comment in `src/test/setup.ts` for why a second, redundant
      // server is no longer needed here). The batch size bounds CONCURRENT sockets,
      // independent of whether there's one server or many, while keeping
      // total wall-clock time low enough that the whole 1201-request burst
      // — bounded by this test's own 30s timeout below — cannot span more
      // than 2 windows (spanning 3 would need >60s), so the pigeonhole
      // guarantee above holds unconditionally, not just probabilistically.
      const PREVIEW_RATE_LIMIT = 600;
      const TOTAL_REQUESTS = 2 * PREVIEW_RATE_LIMIT + 1;
      const BATCH_SIZE = 50;
      const fire = () => request(app).post('/api/v2/pages/preview').set(authHeaders(rateLimitedToken)).send({ body: '# hello' });
      const responses: Awaited<ReturnType<typeof fire>>[] = [];
      for (let i = 0; i < TOTAL_REQUESTS; i += BATCH_SIZE) {
        const batchSize = Math.min(BATCH_SIZE, TOTAL_REQUESTS - i);
        const batch = await Promise.all(Array.from({ length: batchSize }, fire));
        responses.push(...batch);
      }
      expect(responses.every((res) => res.status === 200 || res.status === 429)).toBe(true);

      const limited = responses.find((res) => res.status === 429);
      expect(limited).toBeDefined();
      expect(limited?.body.error).toBe('rate_limited');
      expect(typeof limited?.body.retryAfterSeconds).toBe('number');
      expect(limited?.headers['retry-after']).toBeDefined();
    }, 30_000);
  });

  // feature-plugin-renderer-mermaid spec §7 — the fixture-based tests
  // above prove the generic `previewPolicy: 'server-render'` dispatch
  // mechanism (and its zero-I/O default-policy / embed / URL passthrough
  // counterpart) at the HTTP route level, independent of any specific
  // plugin. This block proves the SAME route reaches the SHARED renderer
  // registry (`crowi.getRenderer().registry` — the one `page-preview.ts`
  // actually calls `run()` against, not a throwaway `RendererRegistryImpl`)
  // under the two lang tags the real plugins register in production:
  // `mermaid` (`previewPolicy: 'server-render'`) actually renders through
  // `POST /pages/preview`, and `plantuml` (network I/O, no
  // `previewPolicy`) is never invoked. feature-renderer-plugin-boundary
  // Phase 2 (§1/§4) converted this block off the real
  // `@crowi/plugin-renderer-{mermaid,plantuml}` package imports onto local
  // fake `CodeBlockRenderer`s with the SAME registration shape — the real
  // plugins' production seam moved to `packages/e2e/tests/renderer-plugins.spec.ts`.
  describe('shared-registry integration through the HTTP route (spec §7 AC "editor preview parity")', () => {
    const MERMAID_PLUGIN = '@crowi/plugin-renderer-mermaid';
    const PLANTUML_PLUGIN = '@crowi/plugin-renderer-plantuml';
    const fixtureLogger: PluginLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

    let plantumlRenderSpy: jest.Mock;

    beforeAll(() => {
      // Register onto the SAME registry `crowi.getRenderer()` hands the
      // route — otherwise this would just re-prove the fixture-based
      // tests above, not the shared-registry wiring.
      const registry = crowi.getRenderer().registry;
      registry.addCodeBlockRenderer(
        'mermaid',
        {
          cacheVersion: 2,
          previewPolicy: 'server-render',
          render: (info) => ({
            html: `<img class="diagram-embed mermaid-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="Mermaid diagram" src="data:image/svg+xml;base64,${Buffer.from(info.source).toString('base64')}">`,
          }),
        },
        MERMAID_PLUGIN,
        fixtureLogger,
      );
      plantumlRenderSpy = jest.fn(() => ({ html: '<div>should never appear in preview</div>' }));
      registry.addCodeBlockRenderer('plantuml', { cacheVersion: 3, render: plantumlRenderSpy }, PLANTUML_PLUGIN, fixtureLogger);
    });

    it('a "mermaid" fence server-renders with no pageId and writes nothing to PluginRenderCache (AC 9)', async () => {
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const before = await PluginRenderCache.countDocuments({}).exec();

      const body = ['```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n');
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

      expect(res.status).toBe(200);
      const ast = res.body.renderedAst as { children: Array<{ type: string; value?: string }> };
      const node = ast.children[0];
      expect(node.type).toBe('html');
      expect(node.value).toContain('<img');
      expect(node.value).toContain('class="diagram-embed mermaid-embed"');
      expect(node.value).toContain('data-crowi-renderer-state="ready"');
      expect(node.value).toContain('src="data:image/svg+xml;base64,');
      // The `renderCodeBlockForPreview` scroll-sync anchor (spec §7 item 6).
      expect(node.value).toContain('data-source-line="1"');
      // Zero PlantUML render calls from this request either.
      expect(plantumlRenderSpy).not.toHaveBeenCalled();

      const after = await PluginRenderCache.countDocuments({}).exec();
      expect(after).toBe(before);
    });

    it('a "plantuml" fence and a bare URL both stay untouched with no pageId — the default-policy renderer never calls render() (AC 10)', async () => {
      const body = ['```plantuml', '@startuml', 'A -> B', '@enduml', '```', '', 'https://example.com'].join('\n');
      const res = await request(app).post('/api/v2/pages/preview').set(authHeaders(accessToken)).send({ body });

      expect(res.status).toBe(200);
      const ast = res.body.renderedAst as { children: Array<{ type: string; lang?: string }> };
      expect(ast.children[0].type).toBe('code');
      expect(ast.children[0].lang).toBe('plantuml');
      expect(plantumlRenderSpy).not.toHaveBeenCalled();
    });
  });
});
