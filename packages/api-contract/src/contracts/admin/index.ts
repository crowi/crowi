import { initContract } from '@ts-rest/core';
import { adminSecurityContract } from './security';

const c = initContract();

/**
 * Aggregate router for all admin-only endpoints. As more admin sections are
 * migrated (auth / app / mail / users / etc.), they should be added here so
 * the API client surfaces them under `apiClient.admin.<section>.*`.
 */
export const adminContract = c.router({
  security: adminSecurityContract,
});
