import fs from 'node:fs/promises';
import { E2E_ARTIFACTS_DIR, E2E_AUTH_DIR, E2E_DB_NAME, E2E_MONGO_URI } from './config';
import { assertE2eDatabaseName, dropE2eDatabase } from './db';
import { preflightDockerServices } from './preflight';
import { clearMailpitMessages } from './mailpit';

export async function globalSetup(): Promise<void> {
  // The Playwright runner process does not inherit per-webServer env. Never use
  // process.env.MONGO_URI here: a developer shell may point it at crowi_dev2 or crowi.
  assertE2eDatabaseName(E2E_MONGO_URI);

  await preflightDockerServices();
  await fs.rm(E2E_AUTH_DIR, { recursive: true, force: true });
  await fs.rm(E2E_ARTIFACTS_DIR, { recursive: true, force: true });
  await fs.mkdir(E2E_AUTH_DIR, { recursive: true });
  await fs.mkdir(E2E_ARTIFACTS_DIR, { recursive: true });

  await dropE2eDatabase();
  await clearMailpitMessages();

  console.log(`[e2e] reset MongoDB database '${E2E_DB_NAME}' via hard-coded URI ${E2E_MONGO_URI}`);
}

export default globalSetup;

if (process.argv[1]?.endsWith('global-setup.ts')) {
  globalSetup().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
