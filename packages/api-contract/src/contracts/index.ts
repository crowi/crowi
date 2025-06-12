import { initContract } from '@ts-rest/core';
import { authContract } from './auth';
import { installerContract } from './installer';

const c = initContract();

export const apiContract = c.router({
  auth: authContract,
  installer: installerContract,
});