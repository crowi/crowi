import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import { Express, Router } from 'express';
import Crowi from 'src/crowi';

export default (_crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();

  const appRouter = s.router(apiContract.app, {
    getInfo: async ({ req }) => {
      const config = (req as { config?: { crowi?: Record<string, unknown> } }).config;
      const raw = config?.crowi?.['app:title'] as string | undefined;
      // 'Crowi' is the seed default in models/config.ts; treat that and
      // empty/missing values as "not customized" so the client can render
      // the full lockup instead of an icon-plus-text composition.
      const title = raw && raw !== 'Crowi' ? raw : null;
      return { status: 200 as const, body: { title } };
    },
  });

  createExpressEndpoints(apiContract.app, appRouter, router);
  return router;
};
