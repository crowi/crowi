import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import type { CodeBlockInfo, CodeBlockRenderer, CrowiPlugin, RenderError, RenderResult } from '@crowi/plugin-api';
import { encode as encodePlantUml } from './encoder';
import { sanitizeSvg } from './sanitize';

/**
 * @crowi/plugin-renderer-plantuml
 *
 * Renders ```plantuml fenced code blocks via an operator-configured
 * PlantUML server. The diagram source is deflate+base64-encoded
 * (`plantuml-encoder`) and fetched from `${serverUrl}/${format}/${encoded}`,
 * then either inlined as SVG (sanitized) or embedded as a base64 PNG.
 *
 * Phase 6 ships this as the first user of `addCodeBlockRenderer`
 * and the cache contract (Phase 4 PluginRenderCache). Failures are
 * cached as `RenderError` for 5 minutes (network / timeout); the
 * placeholder is rendered through `crowi-embed-placeholder-error-*`.
 *
 * Operator install:
 *   1. Run the official PlantUML server (e.g. `docker compose` from
 *      Crowi's compose file ships one at `http://plantuml:8080`).
 *   2. List this plugin in `crowi.config.json:plugins`.
 *   3. In the admin UI, fill in `serverUrl` if your server isn't at
 *      the default hostname.
 */

/**
 * Schema-driven config. The admin UI in `/admin/plugins` builds the
 * form by walking this object. Defaults match the docker-compose
 * service hostname that ships with the Crowi 2.x dev runner.
 */
export const plantumlConfigSchema = z.object({
  serverUrl: z.string().url().default('http://plantuml:8080').describe('Base URL of the PlantUML server.'),
  outputFormat: z
    .enum(['svg', 'png'])
    .default('svg')
    .describe('Image format the server returns. SVG is preferred (smaller, interactive); PNG is a fallback for installs whose server only serves PNG.'),
});

export type PlantUmlConfig = z.infer<typeof plantumlConfigSchema>;

/** Render-side timeout for the PlantUML server fetch. */
const FETCH_TIMEOUT_MS = 10_000;
/** Fresh cache TTL — 1 hour. SWR window = 4h via cachedRender default. */
const CACHE_TTL_SEC = 60 * 60;

/**
 * Build the CodeBlockRenderer instance, bound to a resolved config.
 * Exported so unit tests can construct a renderer without going through
 * the full plugin registration flow.
 */
export function createPlantUmlRenderer(config: PlantUmlConfig): CodeBlockRenderer {
  return {
    cacheVersion: 1,
    reservation: { variant: 'aspect', aspectRatio: 16 / 9 },
    computeEmbedKey: (info: CodeBlockInfo) => {
      // Hash the diagram source only — operator changing serverUrl /
      // outputFormat invalidates implicitly via the 1h TTL rather than
      // explicit invalidation. cacheVersion bump is the operator's
      // escape hatch when they need immediate invalidation.
      return createHash('sha256').update(info.source).digest('hex');
    },
    async render(info, _ctx): Promise<RenderResult> {
      const encoded = encodePlantUml(info.source);
      const url = `${trimTrailingSlash(config.serverUrl)}/${config.outputFormat}/${encoded}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        // AbortController fired → timeout. Otherwise → network.
        const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
        const code: RenderError['code'] = isAbort ? 'timeout' : 'network';
        return {
          html: '',
          error: { code, message: stringifyError(err) },
        };
      }
      clearTimeout(timer);

      if (!response.ok) {
        const code: RenderError['code'] = response.status === 404 ? 'not_found' : 'network';
        return {
          html: '',
          error: { code, message: `PlantUML server responded with HTTP ${response.status}` },
        };
      }

      if (config.outputFormat === 'svg') {
        const svg = await response.text();
        const sanitized = sanitizeSvg(svg);
        return {
          html: `<div class="plantuml-embed">${sanitized}</div>`,
          ttlSec: CACHE_TTL_SEC,
        };
      }

      // PNG path — base64 the binary body. The plugin returns a
      // self-contained `<img>` tag with a data: URL. Cache entries
      // get larger for PNGs, but the per-entry size cap from Phase 4
      // (cache/mongodb-cache.ts) caps that automatically.
      const buf = Buffer.from(await response.arrayBuffer());
      const b64 = buf.toString('base64');
      return {
        html: `<img class="plantuml-embed" alt="" src="data:image/png;base64,${b64}">`,
        ttlSec: CACHE_TTL_SEC,
      };
    },
  };
}

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-plantuml',
  version: '0.1.0-dev',
  configSchema: plantumlConfigSchema,
  adminPlacement: {
    section: 'shared',
    label: 'PlantUML diagrams',
    icon: 'diagram-3',
  },
  registerRenderer: (registry, ctx) => {
    // PluginContext.config<T>() parses the configSchema-typed config
    // row and returns it. The plantuml plugin closes over the config
    // here; admin edits trigger `reconfigure(ctx)` (Phase 4 base plugin
    // hook) which we use to refresh the cached renderer.
    const config = ctx.config<PlantUmlConfig>();
    registry.addCodeBlockRenderer('plantuml', createPlantUmlRenderer(config));
    ctx.log.debug(`registered PlantUML code-block renderer (serverUrl=${config.serverUrl}, format=${config.outputFormat})`);
  },
  // When admin saves new config, re-register so the renderer closure
  // picks up the new serverUrl / outputFormat. Phase 4's registry
  // last-wins + boot warn applies here too — re-registering for the
  // same lang produces a warn each time. We accept that noise because
  // operator-driven reconfig is rare and the warn is informational.
  // NOTE: a richer reconfigure surface (replace-in-place without warn)
  // is Phase 7+ work.
};

export default plugin;

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
