import type Crowi from 'src/crowi';

import { createHonoApp } from './app';

export { createHonoApp, createJwtAdminRequired, createJwtAuth, defaultHook, honoOnError } from './app';
export type { CrowiHonoBindings } from './app';

export const buildHonoApp = (_crowi: Crowi) => {
  const app = createHonoApp();
  return app;
};

export type AppType = ReturnType<typeof buildHonoApp>;
