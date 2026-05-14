import mongoose from 'mongoose';
import Debug from 'debug';

const debug = Debug('crowi:collab:db');

/**
 * Connect Mongoose to the same MongoDB instance that @crowi/api uses.
 *
 * Mirrors the minimum subset of `packages/api/src/crowi/index.ts`
 * `setupDatabase()` that the collab process needs — no encryption
 * service, no config service, no event wiring. Mongoose's *global*
 * connection (the default `mongoose.connection`) is intentionally used
 * so model factories loaded from @crowi/api dist register on the same
 * connection without any wiring.
 */
export async function connectMongo(uri: string): Promise<typeof mongoose> {
  // Mongoose 6 emits a deprecation warning when strictQuery is left
  // unspecified. The api package leaves it at the default; pin
  // explicitly here so collab restarts don't print the warning twice.
  mongoose.set('strictQuery', true);

  debug('connecting to mongo at %s', uri.replace(/:[^@/]+@/, ':***@'));
  await mongoose.connect(uri);
  debug('mongo connected');
  return mongoose;
}

/**
 * Tear the global Mongoose connection down. Called from the SIGTERM /
 * SIGINT handler so the collab process exits cleanly without leaving
 * sockets in TIME_WAIT.
 */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  debug('disconnecting from mongo');
  await mongoose.disconnect();
}
