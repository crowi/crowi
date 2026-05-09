import { initContract } from '@ts-rest/core';
import { AppInfoResponseSchema } from '../schemas/app';

const c = initContract();

export const appContract = c.router({
  getInfo: {
    method: 'GET',
    path: '/app/info',
    responses: {
      200: AppInfoResponseSchema,
    },
    summary: 'Get public application info (site title etc.)',
  },
});
