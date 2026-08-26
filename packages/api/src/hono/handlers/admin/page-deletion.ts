import { adminPageDeletionRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';

import type Crowi from 'src/crowi';
import { erasePageDeletionRecords, listPageDeletionRecords, listPageDeletionRecordsByPath } from 'src/service/page-history/deletion';

import type { CrowiHonoBindings } from '../../app';
import { createJwtAdminRequired } from '../../middleware/admin';

export const registerPageDeletionRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  app.use('/admin/page-deletions/*', createJwtAdminRequired(crowi));
  app.use('/admin/page-deletions', createJwtAdminRequired(crowi));

  return app
    .openapi(adminPageDeletionRoutes.listPageDeletionsRoute, async (c) => {
      const query = c.req.valid('query');
      const records = await listPageDeletionRecords(crowi, query);
      return c.json({ records }, 200);
    })
    .openapi(adminPageDeletionRoutes.getPageDeletionsByPathRoute, async (c) => {
      const query = c.req.valid('query');
      const records = await listPageDeletionRecordsByPath(crowi, query);
      return c.json({ records }, 200);
    })
    .openapi(adminPageDeletionRoutes.erasePageDeletionRoute, async (c) => {
      const selector = c.req.valid('json');
      const user = c.get('user');
      const deletedCount = await erasePageDeletionRecords(crowi, { actorId: user._id.toString(), selector });
      if (deletedCount === 0) {
        return c.json({ error: { code: 'NOT_FOUND' as const, message: 'No matching page deletion record' } }, 404);
      }
      return c.json({ deletedCount }, 200);
    });
};
