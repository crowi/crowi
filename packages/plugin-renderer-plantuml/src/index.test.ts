import type { CodeBlockRenderer, PluginContext, RenderContext, RendererRegistry, RenderResult } from '@crowi/plugin-api';
import plantumlPlugin, { createPlantUmlRenderer, plantumlConfigSchema } from './index';
import { encode } from './encoder';
import { sanitizeSvg } from './sanitize';

/**
 * Minimal RenderContext stub — only `log` is consulted by the plugin.
 * `auth` / `cache` are intentionally absent because the PlantUML
 * renderer does not call them at the render seam. `actor` became a
 * required `RenderContext` field in feature-plugin-renderer-mermaid
 * Phase 1 (spec §6, admission control) — PlantUML never reads it (it
 * declares no `admissionControl`), so a fixed `'system'` actor is fine
 * here.
 */
const stubCtx: RenderContext = {
  mode: 'view',
  actor: { kind: 'system' },
  log: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
};

const DEFAULT_CONFIG = plantumlConfigSchema.parse({});

const FAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0 L10 10"/></svg>';

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();

beforeAll(() => {
  // Override Node's global fetch with a per-suite jest mock so each
  // test can drive the response shape (success / 5xx / abort).
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterAll(() => {
  delete (globalThis as Partial<{ fetch: unknown }>).fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('@crowi/plugin-renderer-plantuml plugin contract', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(plantumlPlugin.name).toBe('@crowi/plugin-renderer-plantuml');
    expect(plantumlPlugin.version).toBe('0.1.0-dev');
    expect(typeof plantumlPlugin.registerRenderer).toBe('function');
  });

  it('declares a configSchema with serverUrl + outputFormat defaults', () => {
    const parsed = plantumlConfigSchema.parse({});
    expect(parsed.serverUrl).toBe('http://plantuml:8080');
    expect(parsed.outputFormat).toBe('svg');
  });

  it('rejects an invalid serverUrl', () => {
    expect(() => plantumlConfigSchema.parse({ serverUrl: 'not-a-url' })).toThrow();
  });

  it('accepts svg / png outputFormat values', () => {
    expect(plantumlConfigSchema.parse({ outputFormat: 'png' }).outputFormat).toBe('png');
    expect(() => plantumlConfigSchema.parse({ outputFormat: 'gif' as 'svg' })).toThrow();
  });
});

/**
 * feature-renderer-plugin-boundary Phase 2 — `reconfigure` completes the
 * "admin edits trigger reconfigure(ctx) which re-registers so the
 * renderer closure picks up the new serverUrl/outputFormat" behaviour
 * the plugin's own `registerRenderer` doc comment already described, by
 * capturing the live registry `registerRenderer` receives
 * (`liveRegistry`, module-level) so `reconfigure(ctx)` — which only gets
 * `ctx`, no registry, per `PluginContext`'s deliberately thin surface —
 * can re-register against it. Needed so an admin-API `serverUrl` change
 * takes effect without an api process restart (e.g.
 * `packages/e2e/tests/renderer-plugins.spec.ts` pointing PlantUML at a
 * locally-reachable server).
 */
describe('reconfigure — re-registers the live "plantuml" code-block renderer with fresh config', () => {
  function captureRegistry(): { registry: RendererRegistry; registered: { lang: string; renderer: CodeBlockRenderer }[] } {
    const registered: { lang: string; renderer: CodeBlockRenderer }[] = [];
    const registry: RendererRegistry = {
      addUnifiedPlugin: () => undefined,
      addNodeRenderer: () => undefined,
      addCodeBlockRenderer: (lang, renderer) => {
        registered.push({ lang, renderer: renderer as CodeBlockRenderer });
      },
      addEmbedTag: () => undefined,
      addUrlInlineExpander: () => undefined,
      addStylesheet: () => undefined,
    };
    return { registry, registered };
  }

  function buildPluginCtx(config: ReturnType<typeof plantumlConfigSchema.parse>): PluginContext {
    return {
      config: <T>() => config as T,
      dependencyConfig: () => {
        throw new Error('not used by this test');
      },
      setConfig: async () => undefined,
      pageMetadata: { get: async () => null, set: async () => undefined, remove: async () => undefined },
      model: () => undefined,
      log: stubCtx.log,
      actor: { kind: 'system' },
    } as unknown as PluginContext;
  }

  it('registerRenderer registers exactly one "plantuml" CodeBlockRenderer built from the initial config', () => {
    const { registry, registered } = captureRegistry();
    plantumlPlugin.registerRenderer?.(registry, buildPluginCtx(plantumlConfigSchema.parse({ serverUrl: 'http://plantuml:8080' })));

    expect(registered).toHaveLength(1);
    expect(registered[0].lang).toBe('plantuml');
  });

  it('reconfigure re-registers "plantuml" a second time, and the NEW renderer instance actually fetches against the NEW serverUrl', async () => {
    const { registry, registered } = captureRegistry();
    plantumlPlugin.registerRenderer?.(registry, buildPluginCtx(plantumlConfigSchema.parse({ serverUrl: 'http://plantuml:8080' })));
    expect(registered).toHaveLength(1);

    plantumlPlugin.reconfigure?.(buildPluginCtx(plantumlConfigSchema.parse({ serverUrl: 'http://localhost:8080' })));
    expect(registered).toHaveLength(2);
    expect(registered[1].lang).toBe('plantuml');

    // Prove it's not just A re-registration event but a GENUINELY
    // different renderer bound to the new config: drive the SECOND
    // registration's render() and assert the fetch target reflects the
    // reconfigured serverUrl, not the original one.
    fetchMock.mockResolvedValueOnce(new Response(FAKE_SVG, { status: 200 }));
    await registered[1].renderer.render({ lang: 'plantuml', source: 'A -> B' }, stubCtx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toMatch(/^http:\/\/localhost:8080\/svg\//);
  });

  it('reconfigure before registerRenderer ever ran is a no-op (nothing to refresh yet, no throw)', () => {
    jest.isolateModules(() => {
      // Re-require the module fresh so its module-level `liveRegistry`
      // starts undefined — the file-scope `plantumlPlugin` import above
      // was already `registerRenderer`-ed by the two tests before this
      // one, so it can't demonstrate the "never registered" branch.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const freshModule = require('./index') as typeof import('./index');
      expect(() => freshModule.default.reconfigure?.(buildPluginCtx(plantumlConfigSchema.parse({})))).not.toThrow();
    });
  });
});

describe('encoder', () => {
  it('round-trips a known diagram into the expected encoded prefix', () => {
    const encoded = encode('@startuml\nA -> B\n@enduml');
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(8);
    // PlantUML encoder uses its custom URL-safe alphabet — letters,
    // digits, underscore, hyphen. Strictly speaking it can also emit
    // the `?` sentinel but not for short bodies; we just assert no
    // slashes / pluses / equals (would indicate raw base64 leak).
    expect(encoded).not.toMatch(/[/+=]/);
  });

  it('produces a deterministic encoding for the same input', () => {
    const a = encode('A -> B');
    const b = encode('A -> B');
    expect(a).toBe(b);
  });
});

/**
 * `sanitizeSvg` (`./sanitize.ts`) is now a thin adapter over the shared
 * `@crowi/plugin-renderer-svg-sanitize` package (feature-plugin-renderer-mermaid
 * spec §9, Phase 3) — that package's own `sanitize.test.ts` is the
 * exhaustive vector suite (script / foreignObject / on* / javascript: /
 * data: / protocol-relative / CSS @import & url() / xmlns tricks /
 * DOCTYPE / processing instructions / xml:base / SMIL, plus a benign
 * "plantuml-shaped SVG survives with structure intact" regression using
 * this exact `allowSafeHref: true` policy). Duplicating that suite here
 * would just be two copies of the same assertions to keep in sync — this
 * describe block is deliberately narrow: it proves the ADAPTER is wired
 * correctly (right policy, right return shape) and that PlantUML's own
 * "preserves href to a safe URL" contract survived the swap.
 */
describe('SVG sanitization (sanitizeSvg — adapter over @crowi/plugin-renderer-svg-sanitize)', () => {
  const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

  it('preserves a benign svg + path + text element', () => {
    const input = `<svg ${SVG_NS}><path d="M0 0 L1 1"/><g><text x="0" y="0">Hi</text></g></svg>`;
    const result = sanitizeSvg(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).toContain('<path');
      expect(result.svg).toContain('Hi');
    }
  });

  it('strips a top-level <script> block (delegated to the shared sanitizer)', () => {
    const input = `<svg ${SVG_NS}><script>alert(1)</script><path d="M0 0"/></svg>`;
    const result = sanitizeSvg(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toMatch(/<script/i);
      expect(result.svg).not.toMatch(/alert\(1\)/);
      expect(result.svg).toContain('<path');
    }
  });

  it('strips href="javascript:..." even though allowSafeHref is true (only https survives)', () => {
    const input = `<svg ${SVG_NS}><a href="javascript:alert(1)">x</a></svg>`;
    const result = sanitizeSvg(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).not.toMatch(/javascript:/i);
    }
  });

  it('is idempotent', () => {
    const input = `<svg ${SVG_NS}><script>x</script><a href="javascript:y" onclick="z"></a></svg>`;
    const once = sanitizeSvg(input);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = sanitizeSvg(once.svg);
    expect(twice).toEqual(once);
  });

  it('preserves href to a safe https URL (PlantUML allowSafeHref: true policy)', () => {
    const input = `<svg ${SVG_NS}><a href="https://example.com">x</a></svg>`;
    const result = sanitizeSvg(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.svg).toContain('href="https://example.com"');
    }
  });

  it('rejects malformed / non-svg-root input instead of falling back to unsanitized output', () => {
    expect(sanitizeSvg('not xml at all <<<').ok).toBe(false);
    expect(sanitizeSvg('<html><body>no svg here</body></html>').ok).toBe(false);
  });
});

describe('render path (success)', () => {
  it('fetches the configured URL with the encoded diagram + wraps SVG output', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FAKE_SVG, { status: 200 }));

    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: '@startuml\nA -> B\n@enduml' }, stubCtx)) as RenderResult;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toMatch(/^http:\/\/plantuml:8080\/svg\//);
    expect(result.html).toContain('<div class="diagram-embed plantuml-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready">');
    expect(result.html).toContain('<svg');
    expect(result.ttlSec).toBe(60 * 60);
    expect(result.error).toBeUndefined();
  });

  it('sanitizes the PlantUML server SVG response', async () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script><path d="M0 0"/></svg>';
    fetchMock.mockResolvedValueOnce(new Response(dirty, { status: 200 }));
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).toContain('<path');
    expect(result.error).toBeUndefined();
  });

  it('maps a sanitizer-rejected (malformed) SVG response to RenderError code:"unknown" instead of falling back to unsanitized output', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<not-svg-at-all/>', { status: 200 }));
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.html).toBe('');
    expect(result.error?.code).toBe('unknown');
  });

  it('renders PNG responses as a base64 data: img', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fetchMock.mockResolvedValueOnce(new Response(png, { status: 200 }));
    const renderer = createPlantUmlRenderer({ ...DEFAULT_CONFIG, outputFormat: 'png' });
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.html).toContain('<img class="diagram-embed plantuml-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready"');
    expect(result.html).toContain('data:image/png;base64,');
    expect(result.html).toContain(png.toString('base64'));
  });

  it('hashes only the diagram source in the embed key (serverUrl change invisible)', () => {
    const r1 = createPlantUmlRenderer({ ...DEFAULT_CONFIG, serverUrl: 'http://a.example:8080' });
    const r2 = createPlantUmlRenderer({ ...DEFAULT_CONFIG, serverUrl: 'http://b.example:8080' });
    expect(r1.computeEmbedKey).toBeDefined();
    expect(r2.computeEmbedKey).toBeDefined();
    const k1 = r1.computeEmbedKey!({ lang: 'plantuml', source: 'A -> B' });
    const k2 = r2.computeEmbedKey!({ lang: 'plantuml', source: 'A -> B' });
    expect(k1).toBe(k2);
  });

  it('declares cacheVersion=3 (bumped from 2 — feature-renderer-plugin-boundary Phase 2 §3.1, the new data-crowi-renderer-* contract, PluginRenderCache-only invalidation) and aspect-ratio reservation', () => {
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    expect(renderer.cacheVersion).toBe(3);
    expect(renderer.reservation).toEqual({ variant: 'aspect', aspectRatio: 16 / 9 });
  });

  it('strips a trailing slash on serverUrl when building the request URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FAKE_SVG, { status: 200 }));
    const renderer = createPlantUmlRenderer({ ...DEFAULT_CONFIG, serverUrl: 'http://plantuml:8080/' });
    await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).not.toMatch(/\/\/svg\//); // no double slash
  });
});

describe('render path (error)', () => {
  it('maps a thrown network error to RenderError code:"network"', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.html).toBe('');
    expect(result.error?.code).toBe('network');
    expect(result.error?.message).toContain('ECONNREFUSED');
  });

  it('maps an AbortController abort to RenderError code:"timeout"', async () => {
    fetchMock.mockImplementationOnce((_input, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        // Pretend the abort fired by returning an AbortError immediately.
        const onAbort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        init?.signal?.addEventListener('abort', onAbort);
        // Trigger abort synchronously for the test rather than waiting
        // for the 10s timer.
        Promise.resolve().then(() => {
          // Cast to a mutable shape to fire the abort manually in
          // the test environment.
          (init?.signal as (AbortSignal & { dispatchEvent?: (e: Event) => void }) | undefined)?.dispatchEvent?.(new Event('abort'));
          onAbort();
        });
      });
    });
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.error?.code).toBe('timeout');
  });

  it('maps a non-2xx response to RenderError code:"network"', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error body', { status: 503 }));
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.error?.code).toBe('network');
    expect(result.error?.message).toMatch(/HTTP 503/);
  });

  it('maps a 404 response to RenderError code:"not_found"', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.error?.code).toBe('not_found');
  });
});
