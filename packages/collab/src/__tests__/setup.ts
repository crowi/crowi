import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/**
 * Lifecycle helpers for the smoke test. Spins up an isolated
 * MongoDB-in-memory instance, opens a Mongoose connection, and tears
 * everything down on teardown. Patterned on
 * `packages/api/src/test/crowi-environment.js` but stripped to just
 * the Mongo bits — collab tests don't need Crowi class boot, plugin
 * config, etc.
 */
export interface SmokeMongo {
  uri: string;
  stop(): Promise<void>;
}

export async function startInMemoryMongo(): Promise<SmokeMongo> {
  const memory = await MongoMemoryServer.create();
  const uri = memory.getUri();
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  return {
    uri,
    async stop() {
      await mongoose.disconnect();
      await memory.stop();
    },
  };
}
