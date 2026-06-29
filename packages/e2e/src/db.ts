import { MongoClient } from 'mongodb';
import { E2E_DB_NAME, E2E_MONGO_URI } from './config';

export function databaseNameFromMongoUri(uri: string): string {
  const parsed = new URL(uri);
  const name = parsed.pathname.replace(/^\//, '').split('?')[0];
  return decodeURIComponent(name);
}

export function assertE2eDatabaseName(uri: string): void {
  const dbName = databaseNameFromMongoUri(uri);
  if (dbName !== E2E_DB_NAME) {
    throw new Error(`Refusing to drop MongoDB database '${dbName || '(empty)'}'. The E2E database must be exactly '${E2E_DB_NAME}'.`);
  }
}

export async function dropE2eDatabase(): Promise<void> {
  assertE2eDatabaseName(E2E_MONGO_URI);

  const client = new MongoClient(E2E_MONGO_URI, { serverSelectionTimeoutMS: 3_000 });
  try {
    await client.connect();
    const dbName = databaseNameFromMongoUri(E2E_MONGO_URI);
    if (dbName !== E2E_DB_NAME) {
      throw new Error(`Refusing to drop MongoDB database '${dbName}'. The E2E database must be exactly '${E2E_DB_NAME}'.`);
    }
    await client.db(dbName).dropDatabase();
  } finally {
    await client.close();
  }
}
