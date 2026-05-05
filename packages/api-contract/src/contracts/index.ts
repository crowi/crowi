import { initContract } from '@ts-rest/core';
import { authContract } from './auth';
import { installerContract } from './installer';
import { tokenAuthContract } from './tokenAuth';
import { meContract } from './me';
import { pageContract } from './page';
import { userContract } from './user';
import { commentContract } from './comment';
import { bookmarkContract } from './bookmark';
import { revisionContract } from './revision';
import { notificationContract } from './notification';

const c = initContract();

export const apiContract = c.router({
  auth: authContract, // Legacy - to be removed
  installer: installerContract,
  tokenAuth: tokenAuthContract,
  me: meContract,
  page: pageContract,
  user: userContract,
  comment: commentContract,
  bookmark: bookmarkContract,
  revision: revisionContract,
  notification: notificationContract,
});
