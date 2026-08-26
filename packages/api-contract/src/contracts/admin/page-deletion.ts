import { createRoute, z } from '@hono/zod-openapi';

import {
  AdminRequiredErrorSchema,
  AuthenticationRequiredErrorSchema,
  InternalServerErrorSchema,
  NotFoundErrorSchema,
  ValidationErrorSchema,
} from '../../schemas/common';

const ObjectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/);
const LimitSchema = z.coerce.number().int().min(1).max(100).default(50);

export const PageDeletionRecordSchema = z.object({
  _id: ObjectIdSchema,
  pageId: ObjectIdSchema,
  path: z.string(),
  actor: ObjectIdSchema.nullable(),
  deletedAt: z.string().datetime(),
  mode: z.literal('user_hard_delete'),
});

export const PageDeletionListResponseSchema = z.object({ records: z.array(PageDeletionRecordSchema) });
export const ErasePageDeletionResponseSchema = z.object({ deletedCount: z.number().int().nonnegative() });

const commonResponses = {
  401: { description: 'Authentication required', content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } } },
  403: { description: 'Admin permission required', content: { 'application/json': { schema: AdminRequiredErrorSchema } } },
  500: { description: 'Internal server error', content: { 'application/json': { schema: InternalServerErrorSchema } } },
} as const;

export const listPageDeletionsRoute = createRoute({
  method: 'get',
  path: '/admin/page-deletions',
  tags: ['admin.page-deletions'],
  security: [{ bearerAuth: [] }],
  summary: 'List recent page deletion records or find them by deleted page id',
  request: { query: z.object({ pageId: ObjectIdSchema.optional(), limit: LimitSchema }) },
  responses: {
    200: { description: 'Page deletion records', content: { 'application/json': { schema: PageDeletionListResponseSchema } } },
    400: { description: 'Invalid query', content: { 'application/json': { schema: ValidationErrorSchema } } },
    ...commonResponses,
  },
});

export const getPageDeletionsByPathRoute = createRoute({
  method: 'get',
  path: '/admin/page-deletions/by-path',
  tags: ['admin.page-deletions'],
  security: [{ bearerAuth: [] }],
  summary: 'List deletion records for one exact historical path',
  request: { query: z.object({ path: z.string().min(1), limit: LimitSchema }) },
  responses: {
    200: { description: 'Page deletion records for the path', content: { 'application/json': { schema: PageDeletionListResponseSchema } } },
    400: { description: 'Invalid query', content: { 'application/json': { schema: ValidationErrorSchema } } },
    ...commonResponses,
  },
});

export const erasePageDeletionRoute = createRoute({
  method: 'delete',
  path: '/admin/page-deletions',
  tags: ['admin.page-deletions'],
  security: [{ bearerAuth: [] }],
  summary: 'Erase one deletion record or every record for one exact path',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.union([z.object({ recordId: ObjectIdSchema }).strict(), z.object({ path: z.string().min(1) }).strict()]),
        },
      },
    },
  },
  responses: {
    200: { description: 'Number of erased records', content: { 'application/json': { schema: ErasePageDeletionResponseSchema } } },
    400: { description: 'A recordId or path selector is required', content: { 'application/json': { schema: ValidationErrorSchema } } },
    404: { description: 'No matching deletion record', content: { 'application/json': { schema: NotFoundErrorSchema } } },
    ...commonResponses,
  },
});

export const adminPageDeletionRoutes = {
  listPageDeletionsRoute,
  getPageDeletionsByPathRoute,
  erasePageDeletionRoute,
};

export type PageDeletionRecord = z.infer<typeof PageDeletionRecordSchema>;
export type ErasePageDeletionInput = { recordId: string } | { path: string };
