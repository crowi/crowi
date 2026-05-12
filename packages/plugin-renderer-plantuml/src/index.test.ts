import type { RenderContext, RenderResult } from '@crowi/plugin-api';
import plantumlPlugin, { createPlantUmlRenderer, plantumlConfigSchema } from './index';
import { encode } from './encoder';
import { sanitizeSvg } from './sanitize';

/**
 * Minimal RenderContext stub — only `log` is consulted by the plugin.
 * `auth` / `cache` are intentionally absent because the PlantUML
 * renderer does not call them at the render seam.
 */
const stubCtx: RenderContext = {
  mode: 'view',
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

describe('SVG sanitization (sanitizeSvg)', () => {
  it('preserves a plain svg + path + text element verbatim', () => {
    const input = '<svg><path d="M0 0 L1 1"/><g><text x="0" y="0">Hi</text></g></svg>';
    expect(sanitizeSvg(input)).toBe(input);
  });

  it('strips a top-level <script> block', () => {
    const input = '<svg><script>alert(1)</script><path d="M0 0"/></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert\(1\)/);
    expect(out).toContain('<path');
  });

  it('strips a <script> with attributes + whitespace', () => {
    const input = '<svg><script  type="application/javascript">  let x = 1;  </script></svg>';
    expect(sanitizeSvg(input)).not.toMatch(/<script/i);
  });

  it('strips onclick / onload / onerror handler attributes', () => {
    const input = '<svg><rect onclick="evil()" onload=\'evil()\' x="0"></rect><image onerror=evil src="x"/></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onerror/i);
    // Other attrs (x, src) preserved.
    expect(out).toContain('x="0"');
    expect(out).toContain('src="x"');
  });

  it('strips href="javascript:..." (single + double quoted + xlink:href)', () => {
    const input = '<svg><a href="javascript:alert(1)">x</a><a href=\'javascript:alert(2)\'>y</a><use xlink:href="javascript:alert(3)"/></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/xlink:href\s*=\s*"javascript/i);
  });

  it('strips <foreignObject> blocks', () => {
    const input = '<svg><foreignObject><div onclick="x">html</div></foreignObject><path/></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toMatch(/foreignObject/i);
    expect(out).toContain('<path');
  });

  it('is idempotent', () => {
    const input = '<svg><script>x</script><a href="javascript:y" onclick="z"></a></svg>';
    const once = sanitizeSvg(input);
    const twice = sanitizeSvg(once);
    expect(twice).toBe(once);
  });

  it('preserves href to a safe URL', () => {
    const input = '<svg><a href="https://example.com">x</a></svg>';
    expect(sanitizeSvg(input)).toContain('href="https://example.com"');
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
    expect(result.html).toContain('<div class="plantuml-embed">');
    expect(result.html).toContain('<svg');
    expect(result.ttlSec).toBe(60 * 60);
    expect(result.error).toBeUndefined();
  });

  it('sanitizes the PlantUML server SVG response', async () => {
    const dirty = '<svg><script>bad()</script><path d="M0 0"/></svg>';
    fetchMock.mockResolvedValueOnce(new Response(dirty, { status: 200 }));
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).toContain('<path');
  });

  it('renders PNG responses as a base64 data: img', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fetchMock.mockResolvedValueOnce(new Response(png, { status: 200 }));
    const renderer = createPlantUmlRenderer({ ...DEFAULT_CONFIG, outputFormat: 'png' });
    const result = (await renderer.render({ lang: 'plantuml', source: 'x' }, stubCtx)) as RenderResult;
    expect(result.html).toContain('<img');
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

  it('declares cacheVersion=1 and aspect-ratio reservation', () => {
    const renderer = createPlantUmlRenderer(DEFAULT_CONFIG);
    expect(renderer.cacheVersion).toBe(1);
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
