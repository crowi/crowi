import { initContract } from '@ts-rest/core';
import { PreviewPageRequestSchema, PreviewPageResponseSchema } from '../schemas/page-preview';
import { AuthenticationRequiredErrorSchema, InternalServerErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * Standalone preview contract. Separated from `pageContract` because
 * preview is a read-only render operation (no revision is created) and
 * has no permission scope tied to a specific page — it's "render this
 * arbitrary markdown for the logged-in user", not "fetch this page".
 *
 * The path stays under `/pages/preview` for discoverability alongside
 * the page CRUD endpoints, but the contract export is its own router
 * so the responsibility boundary is explicit.
 */
export const pagePreviewContract = c.router({
  previewPage: {
    method: 'POST',
    path: '/pages/preview',
    body: PreviewPageRequestSchema,
    responses: {
      200: PreviewPageResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      500: InternalServerErrorSchema,
    },
    summary: 'Render markdown to mdast for the editor preview pane',
  },
});
