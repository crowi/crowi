import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  InstallerStatusResponseSchema,
  CreateAdminRequestSchema,
  CreateAdminResponseSchema,
} from '../schemas/installer';

const c = initContract();

export const installerContract = c.router({
  getStatus: {
    method: 'GET',
    path: '/installer',
    responses: {
      200: InstallerStatusResponseSchema,
    },
    summary: 'Get installer status',
  },
  createAdmin: {
    method: 'POST',
    path: '/installer/createAdmin',
    body: CreateAdminRequestSchema,
    responses: {
      200: CreateAdminResponseSchema,
      400: CreateAdminResponseSchema,
    },
    summary: 'Create initial admin user',
  },
});