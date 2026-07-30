import { createPageViaApi, getPageRenderedAst, listLoadedPluginNamesViaApi, updatePluginConfigViaApi } from '../src/api';
import { E2E_API_URL, E2E_WEB_URL } from '../src/config';
import { countPluginRenderCacheRows, forceStaleRendererVersion, getPluginRenderCacheFetchedAt } from '../src/db';
import { expect, test } from '../src/fixtures';

/**
 * feature-renderer-plugin-boundary Phase 2 (§1/§9) — the dedicated
 * reference-runner integration suite for the three optional renderer
 * plugins packages/api and packages/web no longer import for real
 * (`katex.e2e.test.ts` / `plantuml.e2e.test.ts` / `mermaid.e2e.test.ts` in
 * `@crowi/api`, `render-mdast.test.tsx` in `@crowi/web`, all converted to
 * local fakes — see those files' own doc comments). This is the one place
 * outside the plugin packages themselves, `apps/crowi-runner`, and
 * `packages/e2e` where a genuine `@crowi/plugin-renderer-{katex,plantuml,
 * mermaid}` import is expected — the E2E runner (`packages/e2e/runner/`)
 * resolves them the same way `apps/crowi-runner` does at boot
 * (`createRequire(projectDir)` + `.npmrc`'s `@crowi/plugin-*` hoist).
 *
 * Single scenario, end to end through a real browser + a real API process
 * (separate origins, `E2E_API_URL`/`E2E_WEB_URL` — `packages/e2e/src/config.ts`):
 *   1. all three plugins are loaded.
 *   2. one page is saved mixing KaTeX/PlantUML/Mermaid source.
 *   3. the API side is asserted directly: `PluginRenderCache` rows exist
 *      for PlantUML/Mermaid (KaTeX has none — a synchronous node renderer,
 *      no embed/code-block cache entry), the serialized AST
 *      (`page.revision.renderedAst`) carries each plugin's REAL output
 *      including the new `data-crowi-renderer-presentation`/`-state`
 *      contract (spec §3.1).
 *   4. a genuine cache HIT is proven deterministically: the page's stored
 *      `rendererVersion` is corrupted directly via MongoDB
 *      (`forceStaleRendererVersion`, `packages/e2e/src/db.ts`) — the same
 *      "revision predates this pipeline version" shape
 *      `computeRevisionRenderArtifactsAsync` already falls back for — so
 *      the next `GET` re-runs the full pipeline (`runRender(mode: 'read',
 *      ...)`) through the SAME `PluginRenderCache`-backed dispatch a save
 *      uses. A plain GET never fires `pageEvent('update', ...)`, so this
 *      replay never races the render-cache invalidation listener
 *      (`packages/api/src/events/render-cache.ts`) the way re-saving the
 *      page (a real revision UPDATE, which asynchronously invalidates the
 *      whole page's cache the moment it lands) would — a race a black-box
 *      E2E client cannot deterministically avoid. The replayed AST still
 *      carries the `ready` contract (functionally correct) AND each
 *      plugin's cache row's `fetchedAt` is bit-identical to what it was
 *      right after the original save: a real miss/re-render always stamps
 *      a fresh `fetchedAt` on write (`renderer/cache/index.ts`'s
 *      `persistRenderResult`), so an unchanged value can only mean the
 *      plugin's real `render()` was skipped the second time (same-source
 *      cache-hit-skips-render is additionally covered, in isolation, at
 *      the registry/pipeline level by `plantuml.e2e.test.ts` /
 *      `mermaid.e2e.test.ts` in `@crowi/api`).
 *   5. the browser side is asserted: KaTeX's CSS self-serves from the API
 *      origin with `Access-Control-Allow-Origin` set to the web origin
 *      (cross-origin — same guarantee the referenced font URL the CSS
 *      itself points at also gets), the browser actually parses AND
 *      applies it (the `<link>`'s `.sheet` is non-null and the rendered
 *      `.katex` element's computed `font-family` resolves to KaTeX's own
 *      `KaTeX_Main` font — an HTTP 200 alone proves neither), and the
 *      PlantUML/Mermaid diagrams render `ready` and open the
 *      click-to-enlarge dialog (`renderer-presentation.tsx`).
 *
 * PlantUML's `serverUrl` is pointed at the compose-published
 * `http://localhost:8080` server (spec §9 — `docker-compose.yml`'s
 * `plantuml` service) via the admin plugin-config endpoint
 * (`updatePluginConfigViaApi`) — the same generic endpoint
 * `admin-mail-page.ts`'s UI-driven SMTP setup flow PUTs to, called
 * directly here since the config FORM itself isn't what this spec tests.
 * feature-renderer-plugin-boundary Phase 2 also gave the PlantUML plugin
 * a `reconfigure` hook (`packages/plugin-renderer-plantuml/src/index.ts`)
 * so this PUT actually hot-applies against the shared e2e api process
 * with no restart — completing the "admin edits trigger reconfigure(ctx)"
 * behaviour that plugin's own `registerRenderer` doc comment already
 * described but never wired up.
 */

const KATEX_PLUGIN = '@crowi/plugin-renderer-katex';
const PLANTUML_PLUGIN = '@crowi/plugin-renderer-plantuml';
const MERMAID_PLUGIN = '@crowi/plugin-renderer-mermaid';

/** English + Japanese "Enlarge diagram" (`page.diagram_zoom`) — i18n-tolerant literal-key regex, same pattern as `attachments.spec.ts`'s `DOWNLOAD_PATTERN`. */
const ZOOM_BUTTON_PATTERN = /^(Enlarge diagram|図を拡大)$/;

/** Recursively collect every `html`-typed mdast node's `value` string — the raw HTML fragment each renderer plugin actually produced, concatenated for substring assertions. */
function collectHtmlValues(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as { type?: unknown; value?: unknown; children?: unknown[] };
  if (record.type === 'html' && typeof record.value === 'string') out.push(record.value);
  if (Array.isArray(record.children)) {
    for (const child of record.children) collectHtmlValues(child, out);
  }
  return out;
}

test('KaTeX / PlantUML / Mermaid: real activation → save render → cache → serialized AST (API), stylesheet CORS + ready-diagram interaction (browser)', async ({
  adminPage,
  userAPage,
}) => {
  // Real HTTP round-trip to a live PlantUML server + a forked Mermaid
  // render-worker pool cold start, on top of normal page save/navigation —
  // well beyond the config-level 60s default.
  test.setTimeout(120_000);

  await test.step('all three optional renderer plugins are loaded', async () => {
    const loaded = await listLoadedPluginNamesViaApi(adminPage.context());
    expect(loaded).toEqual(expect.arrayContaining([KATEX_PLUGIN, PLANTUML_PLUGIN, MERMAID_PLUGIN]));
  });

  await test.step('point PlantUML at the compose-published local server', async () => {
    await updatePluginConfigViaApi(adminPage.context(), {
      pluginName: PLANTUML_PLUGIN,
      values: { serverUrl: 'http://localhost:8080', outputFormat: 'svg' },
    });
  });

  const token = `e2erenderer${Date.now()}`;
  const pagePath = `/e2e/renderer-plugins/${token}`;
  const body = [
    '# Renderer plugins',
    '',
    `Inline math: $x^2 + y^2 = z^2$ (${token})`,
    '',
    '```plantuml',
    '@startuml',
    'Alice -> Bob: hello',
    '@enduml',
    '```',
    '',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '',
  ].join('\n');

  const pageId = await test.step('save a page mixing all three renderer sources', () => createPageViaApi(userAPage.context(), { path: pagePath, body }));

  await test.step('the serialized AST carries real KaTeX / PlantUML / Mermaid output, PlantUML AND Mermaid each independently carrying the new ready presentation contract', async () => {
    const ast = await getPageRenderedAst(userAPage.context(), pageId);
    const htmlFragments = collectHtmlValues(ast);

    expect(htmlFragments.join('\n')).toContain('class="katex"');

    const plantumlFragment = htmlFragments.find((f) => f.includes('plantuml-embed'));
    expect(plantumlFragment).toBeDefined();
    expect(plantumlFragment).toContain('data-crowi-renderer-presentation="diagram"');
    expect(plantumlFragment).toContain('data-crowi-renderer-state="ready"');
    expect(plantumlFragment).toContain('<svg');

    const mermaidFragment = htmlFragments.find((f) => f.includes('mermaid-embed'));
    expect(mermaidFragment).toBeDefined();
    expect(mermaidFragment).toContain('data-crowi-renderer-presentation="diagram"');
    expect(mermaidFragment).toContain('data-crowi-renderer-state="ready"');
    expect(mermaidFragment).toContain('src="data:image/svg+xml;base64,');
  });

  const cacheFetchedAtAfterSave =
    await test.step('PluginRenderCache carries exactly one row each for PlantUML and Mermaid (KaTeX has none — a synchronous node renderer, no embed/code-block cache entry)', async () => {
      expect(await countPluginRenderCacheRows(pageId, PLANTUML_PLUGIN)).toBe(1);
      expect(await countPluginRenderCacheRows(pageId, MERMAID_PLUGIN)).toBe(1);

      const plantuml = await getPluginRenderCacheFetchedAt(pageId, PLANTUML_PLUGIN);
      const mermaid = await getPluginRenderCacheFetchedAt(pageId, MERMAID_PLUGIN);
      if (!plantuml || !mermaid) throw new Error('PluginRenderCache row is missing a fetchedAt right after save');
      return { plantuml, mermaid };
    });

  await test.step('forcing the stored AST stale and re-reading re-runs the SAME cache-backed dispatch, proving a genuine cache HIT (bit-identical fetchedAt, no duplicate row) rather than a silent re-render', async () => {
    // Corrupts `rendererVersion` directly via MongoDB — the same
    // "revision predates this pipeline version" shape
    // `computeRevisionRenderArtifactsAsync` already falls back for — so
    // the next GET treats the stored AST as stale and re-runs
    // `runRender(mode: 'read', pageId, ...)` through the SAME
    // `PluginRenderCache`-backed dispatch a save uses (`pipeline.ts`'s
    // `dispatch.pageId` branch). A plain GET never fires
    // `pageEvent('update', ...)`, so — unlike re-saving the page — this
    // replay never races the render-cache invalidation listener
    // (`packages/api/src/events/render-cache.ts`).
    await forceStaleRendererVersion(pageId);

    const ast = await getPageRenderedAst(userAPage.context(), pageId);
    // Functionally correct: the replayed read still serves the ready
    // diagram contract — from the reused cache entry, not a fresh render.
    expect(collectHtmlValues(ast).join('\n')).toContain('data-crowi-renderer-state="ready"');

    // No duplicate row — a necessary but not sufficient check: a miss
    // that re-renders would ALSO upsert onto this exact row (identical
    // 4-tuple cache key), so this alone cannot tell hit from miss. The
    // fetchedAt comparison below is the actual discriminating proof.
    expect(await countPluginRenderCacheRows(pageId, PLANTUML_PLUGIN)).toBe(1);
    expect(await countPluginRenderCacheRows(pageId, MERMAID_PLUGIN)).toBe(1);

    // `persistRenderResult` always stamps a fresh `fetchedAt = new
    // Date()` when it writes (miss/expired-then-reblocked). A genuine
    // cache HIT returns the entry as-is and never calls it — so an
    // UNCHANGED `fetchedAt` can only mean the plugin's real render() was
    // skipped this second time.
    const plantumlFetchedAt = await getPluginRenderCacheFetchedAt(pageId, PLANTUML_PLUGIN);
    const mermaidFetchedAt = await getPluginRenderCacheFetchedAt(pageId, MERMAID_PLUGIN);
    expect(plantumlFetchedAt?.getTime()).toBe(cacheFetchedAtAfterSave.plantuml.getTime());
    expect(mermaidFetchedAt?.getTime()).toBe(cacheFetchedAtAfterSave.mermaid.getTime());
  });

  await test.step('browser: KaTeX self-serves its CSS + a referenced font from the API origin, both with CORS for the web origin, and the stylesheet actually applies to the rendered math', async () => {
    await userAPage.goto(pagePath);

    const linkLocator = userAPage.locator('head link[data-crowi-renderer-stylesheet]');
    await expect(linkLocator).toHaveCount(1);
    const href = await linkLocator.getAttribute('href');
    if (!href) throw new Error('renderer stylesheet <link> has no href');
    expect(href.startsWith(`${E2E_API_URL}/api/plugins/${KATEX_PLUGIN}/`)).toBe(true);

    const cssResponse = await fetch(href, { headers: { Origin: E2E_WEB_URL } });
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(cssResponse.headers.get('access-control-allow-origin')).toBe(E2E_WEB_URL);

    const cssText = await cssResponse.text();
    const fontMatch = cssText.match(/url\((fonts\/[^)]+\.woff2)\)/);
    if (!fontMatch) throw new Error('KaTeX CSS did not reference a .woff2 font — cannot verify the font route');
    const fontUrl = new URL(fontMatch[1], href).toString();
    expect(fontUrl.startsWith(`${E2E_API_URL}/api/plugins/${KATEX_PLUGIN}/fonts/`)).toBe(true);

    const fontResponse = await fetch(fontUrl, { headers: { Origin: E2E_WEB_URL } });
    expect(fontResponse.status).toBe(200);
    expect(fontResponse.headers.get('content-type')).toBe('font/woff2');
    expect(fontResponse.headers.get('access-control-allow-origin')).toBe(E2E_WEB_URL);

    // The HTTP-level checks above only prove the API SERVED the CSS — not
    // that the BROWSER actually fetched, parsed, and applied it (codex
    // review finding). `.sheet` is non-null once the browser has
    // successfully parsed the response as a real stylesheet (a
    // cross-origin `<link>` requires `Content-Type: text/css` — already
    // asserted above — or the browser refuses to process it at all).
    await expect.poll(() => linkLocator.evaluate((el: HTMLLinkElement) => el.sheet !== null), { timeout: 15_000 }).toBe(true);

    // Structural/visual proof the stylesheet's rules actually took effect:
    // KaTeX's own bundled CSS defines `.katex { font: normal 1.21em
    // KaTeX_Main, ... }` — without it applied, the rendered math span
    // would resolve to whatever font this page's OWN stylesheet gives a
    // bare `<span>`, never "KaTeX_Main".
    const mathLocator = userAPage.locator('.katex').first();
    await expect(mathLocator).toBeVisible();
    await expect.poll(() => mathLocator.evaluate((el) => getComputedStyle(el).fontFamily), { timeout: 15_000 }).toContain('KaTeX_Main');
  });

  await test.step('browser: the PlantUML and Mermaid diagrams both render ready and open the click-to-enlarge dialog', async () => {
    const zoomButtons = userAPage.getByRole('button', { name: ZOOM_BUTTON_PATTERN });
    await expect(zoomButtons).toHaveCount(2);
    await zoomButtons.first().click();
    await expect(userAPage.getByRole('dialog')).toBeVisible();
  });
});
