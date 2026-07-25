/**
 * RFC-0006 Phase 4 Batch 4 — `pagePreview` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/page-preview.ts`. Single
 * endpoint:
 *
 *   POST /pages/preview — render arbitrary markdown to mdast
 *
 * Auth is shared with the `page` resource: the `revision` handler
 * applies `createJwtAuth(crowi)` broadly to `/pages/*` (and bare
 * `/pages`), so this handler relies on the established register order
 * (`revision -> page -> page-preview` in `buildHonoApp`) and does NOT
 * install jwtAuth itself. Hono does not dedupe middleware by reference;
 * re-installing it would cost a second JWT verify + `User.findById`
 * per request. See the page handler file header for the longer
 * rationale.
 *
 * The renderer pipeline is shared with the save path so edit-preview
 * and page-show produce byte-identical trees for the same input. We
 * call `getRenderer().run()` (not `runRender()`) so we can intercept
 * the raw mdast tree and stamp `data.hProperties['data-source-line']`
 * on every top-level block before serialising — that's how the editor
 * scroll-sync ties CodeMirror viewport positions to preview-pane
 * blocks bidirectionally.
 *
 * Rate limiting (feature-plugin-renderer-mermaid spec §7 item 7):
 *  - 600 req/min/user, name `'preview'`. Same `createRateLimiter(...)` /
 *    `withRateLimit(...)` pattern as `autocomplete.ts` — a shared limiter
 *    instance per process (Redis-backed when `crowi.redis !== null`).
 *  - Applied on the `/pages/preview` literal path. jwtAuth is already
 *    installed broadly on `/pages/*` by the revision handler (see above),
 *    so this only needs to install AFTER that — order is enforced by
 *    `buildHonoApp`'s registration order, not by this file.
 *  - 429 envelope: `{ error: 'rate_limited', message, retryAfterSeconds }`
 *    (the shared `AutocompleteRateLimitErrorSchema` wire shape — same as
 *    `AutocompleteRateLimitErrorSchema`).
 *  - This is a secondary defence against bodyless-request floods; the
 *    primary capacity control is the per-user admission-control
 *    concurrency cap (spec §6), which bounds actual render CPU work
 *    regardless of request rate.
 */
import { previewPageRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import type { Root, RootContent } from 'mdast';

import type Crowi from 'src/crowi';
import { serializeMdast } from 'src/renderer';
import { createRateLimiter } from 'src/util/rate-limit';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';
import { actorFromUser } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { withRateLimit } from '../middleware/rate-limit';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:page-preview');

/** feature-plugin-renderer-mermaid spec §7 item 7 — per-user budget for `POST /pages/preview`. */
const PREVIEW_RATE_LIMIT = 600;
const PREVIEW_RATE_WINDOW_MS = 60_000;

// mdast's `Data` is intentionally empty (open to augmentation); the
// `hProperties` field is the `mdast-util-to-hast` convention shared
// by renderer plugins. Carry the augmentation as a local alias so
// the cast below reads as intent, not noise.
type MdastNodeWithHProps = RootContent & { data?: { hProperties?: Record<string, unknown> } };

/**
 * Attach `data-source-line="<1-based-line>"` to every top-level mdast
 * child via `data.hProperties`. `mdast-util-to-hast` flows this onto
 * the produced hast node's `properties`, and `hast-util-to-jsx-runtime`
 * surfaces it as a real DOM attribute — giving the editor preview a
 * way to bidirectionally scroll-sync with the CodeMirror viewport.
 *
 * Only top-level children are tagged: scroll sync anchors on block
 * boundaries, and inline children inside a paragraph share the parent's
 * source line.
 */
const injectSourceLineAnchors = (tree: Root): void => {
  for (const child of tree.children) {
    const line = child.position?.start?.line;
    if (typeof line !== 'number') continue;
    const node = child as MdastNodeWithHProps;
    const data = node.data ?? (node.data = {});
    const hProperties = data.hProperties ?? (data.hProperties = {});
    hProperties['data-source-line'] = line;
  }
};

export const registerPagePreviewRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  // One shared limiter per process. `crowi.redis` is `null` in
  // single-instance dev, which selects the in-memory fallback (see
  // `util/rate-limit.ts`).
  const limiter = createRateLimiter({
    name: 'preview',
    limit: PREVIEW_RATE_LIMIT,
    windowMs: PREVIEW_RATE_WINDOW_MS,
    redisClient: crowi.redis ?? null,
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });
  app.use(
    '/pages/preview',
    withRateLimit({
      limiter,
      wireShape: 'autocomplete-envelope', // the contract reuses AutocompleteRateLimitErrorSchema (same wire shape).
      message: () => 'Preview rate limit exceeded. Try again shortly.',
    }),
  );

  return app.openapi(previewPageRoute, async (c) => {
    const user = c.get('user');
    const { body } = c.req.valid('json');

    try {
      // `mode: 'view'` mirrors what `computeRevisionRenderArtifactsAsync`
      // uses for read-path on-the-fly fallback; the registered transforms
      // decide whether to short-circuit based on it. No `pageId` is
      // supplied — `pipeline.ts`'s page-less branch runs ONLY
      // `previewPolicy: 'server-render'` code-block dispatch
      // (`makePreviewCodeBlockDispatch`); embed-tags / url-inline-expand
      // stay skipped exactly as before this feature (spec §7 item 3 — no
      // `pageId` to key an embed-cache row against).
      //
      // `actor` + `signal`: feature-plugin-renderer-mermaid spec §6/§7 —
      // admission control needs the actor end-to-end, and the abort
      // signal lets a superseded preview request's queued admission job
      // (§6) be dropped instead of wasting a render slot.
      // `Renderer.run`'s `options.actor` is a required field, so every
      // call site needs this regardless of preview parity.
      //
      // `c.req.raw.signal` on premature disconnect (spec §7 item 8's "実機
      // で確認" requirement): reproduced against this repo's pinned
      // `@hono/node-server` (2.0.3) on Node v24.15.0 — a standalone `serve()`
      // handler awaited 2s, a raw TCP client sent the request headers+body
      // then called `socket.destroy()` ~200ms later (simulating a tab close
      // / navigation mid-request, not a graceful FIN). The handler's
      // `c.req.raw.signal` fired its `abort` event with `signal.aborted ===
      // true`. Confirmed guaranteed on this stack — no fallback to
      // rate-limit-only cancellation is needed for the "abort a queued
      // preview's admission job" behaviour this powers.
      //
      // `getRenderer()` throws if setup hasn't run; the catch maps it to
      // 500 alongside any pipeline failure.
      const { tree } = await crowi.getRenderer().run(body, {
        mode: 'view',
        actor: actorFromUser(user),
        signal: c.req.raw.signal,
      });
      injectSourceLineAnchors(tree);
      return c.json({ renderedAst: serializeMdast(tree) }, 200);
    } catch (err) {
      debug('preview pipeline failed:', (err as Error).message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  });
};
