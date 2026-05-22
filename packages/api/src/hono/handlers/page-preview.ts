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
 */
import { previewPageRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import type { Root, RootContent } from 'mdast';

import type Crowi from 'src/crowi';
import { serializeMdast } from 'src/renderer';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:page-preview');

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
  return app.openapi(previewPageRoute, async (c) => {
    const { body } = c.req.valid('json');

    try {
      // `mode: 'view'` mirrors what `computeRevisionRenderArtifactsAsync`
      // uses for read-path on-the-fly fallback; the registered transforms
      // decide whether to short-circuit based on it. No `pageId` is
      // supplied — plugin-dispatch transforms degrade to plain text in
      // that case, which is the right behaviour for preview content that
      // may belong to no persisted page yet.
      //
      // `getRenderer()` throws if setup hasn't run; the catch maps it to
      // 500 alongside any pipeline failure.
      const { tree } = await crowi.getRenderer().run(body, { mode: 'view' });
      injectSourceLineAnchors(tree);
      return c.json({ renderedAst: serializeMdast(tree) }, 200);
    } catch (err) {
      debug('preview pipeline failed:', (err as Error).message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  });
};
