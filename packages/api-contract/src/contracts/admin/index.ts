import { initContract } from '@ts-rest/core';
import { adminAppContract } from './app';
import { adminAuthContract } from './auth';
import { adminMailContract } from './mail';
import { adminPluginsContract } from './plugins';
import { adminSecurityContract } from './security';
import { adminShareContract } from './share';
import { adminStorageContract } from './storage';
import { adminUsersContract } from './users';

const c = initContract();

/**
 * Aggregate router for all admin-only endpoints. As more admin sections are
 * migrated (auth / mail / users / etc.), they should be added here so
 * the API client surfaces them under `apiClient.admin.<section>.*`.
 */
export const adminContract = c.router({
  app: adminAppContract,
  auth: adminAuthContract,
  security: adminSecurityContract,
  mail: adminMailContract,
  share: adminShareContract,
  storage: adminStorageContract,
  users: adminUsersContract,
  plugins: adminPluginsContract,
});
