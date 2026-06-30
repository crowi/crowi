import path from 'node:path';

export const E2E_DB_NAME = 'crowi_e2e';
export const E2E_MONGO_URI = `mongodb://localhost:27017/${E2E_DB_NAME}`;

export const E2E_API_PORT = 4311;
export const E2E_WEB_PORT = 4312;
export const E2E_API_URL = `http://localhost:${E2E_API_PORT}`;
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;
export const E2E_MAILPIT_API_URL = 'http://localhost:8025/api/v1';

export const E2E_ROOT_DIR = process.cwd();
export const E2E_AUTH_DIR = path.join(E2E_ROOT_DIR, '.auth');
export const E2E_ARTIFACTS_DIR = path.join(E2E_ROOT_DIR, '.artifacts');

export const storageStatePath = {
  admin: path.join(E2E_AUTH_DIR, 'admin.json'),
  userA: path.join(E2E_AUTH_DIR, 'user-a.json'),
  userB: path.join(E2E_AUTH_DIR, 'user-b.json'),
} as const;

/**
 * Where the `setup` project records shared artifacts the `e2e` project reuses
 * (currently the collab shared page id). Kept in `.auth/` so the whole reusable
 * state set lives in one gitignored directory.
 */
export const sharedStatePath = path.join(E2E_AUTH_DIR, 'shared.json');

/** Path of the single shared wiki page the collab scenario edits. */
export const E2E_SHARED_PAGE_PATH = '/e2e/collab/shared';

export interface E2eSharedState {
  pageId: string;
  pagePath: string;
}

export interface E2eUserCredentials {
  username: string;
  name: string;
  email: string;
  password: string;
}

export const e2eUsers = {
  admin: {
    username: 'e2e-admin',
    name: 'E2E Admin',
    email: 'admin@dev.crowi.wiki',
    password: 'crowi-e2e-admin-password',
  },
  userA: {
    username: 'e2e-user-a',
    name: 'E2E User A',
    email: 'user-a@dev.crowi.wiki',
    password: 'crowi-e2e-user-a-password',
  },
  userB: {
    username: 'e2e-user-b',
    name: 'E2E User B',
    email: 'user-b@dev.crowi.wiki',
    password: 'crowi-e2e-user-b-password',
  },
} satisfies Record<string, E2eUserCredentials>;

export const e2eMail = {
  from: 'crowi-e2e@dev.crowi.wiki',
  smtpHost: 'localhost',
  smtpPort: 1025,
} as const;
