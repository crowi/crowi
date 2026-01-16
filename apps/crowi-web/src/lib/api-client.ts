import { initClient } from '@ts-rest/core';
import { apiContract } from '@crowi/api-contract';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const apiClient = initClient(apiContract, {
  baseUrl: `${API_BASE_URL}/api/v2`,
  baseHeaders: {},
});
