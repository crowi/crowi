#!/usr/bin/env node
import dotenv from 'dotenv';
import Debug from 'debug';
import { loadCollabEnv } from './env';
import { connectMongo, disconnectMongo } from './db';
import { registerModels } from './models';
import { createCollabServer } from './server';
import { getWsTokenUtil } from './ws-token';

const debug = Debug('crowi:collab:boot');

/**
 * Entry point for the standalone Hocuspocus host.
 *
 * Boot order:
 *   1. `dotenv.config()` so MONGO_URI / WS_TOKEN_SECRET / COLLAB_PORT
 *      flow through the same way @crowi/api reads them at server boot.
 *   2. `connectMongo()` opens the shared Mongoose connection.
 *   3. `registerModels()` invokes the api package's model factories
 *      against the now-connected mongoose so collab's hooks share the
 *      exact same schema definitions.
 *   4. `getWsTokenUtil()` resolves `WS_TOKEN_SECRET` once (matching
 *      the api process's lifecycle).
 *   5. `createCollabServer(...).listen()` starts the WebSocket server.
 *   6. SIGINT / SIGTERM trigger graceful shutdown — destroy Hocuspocus
 *      (flushes pending stores) then disconnect Mongoose.
 */
export async function startCollabServer(): Promise<void> {
  dotenv.config();

  const env = loadCollabEnv();
  debug('starting collab process: port=%d address=%s', env.port, env.address);

  await connectMongo(env.mongoUri);

  const models = registerModels();
  const wsTokenUtil = getWsTokenUtil();

  const server = createCollabServer({
    models,
    wsTokenUtil,
    port: env.port,
    address: env.address,
    quiet: env.quiet,
  });

  await server.listen();
  console.log(`[crowi:collab] listening on ws://${env.address}:${env.port}/collab/<pageId>?token=<wsToken>`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[crowi:collab] ${signal} received — shutting down`);
    try {
      await server.destroy();
    } catch (err) {
      console.error('[crowi:collab] error during server.destroy():', err);
    }
    try {
      await disconnectMongo();
    } catch (err) {
      console.error('[crowi:collab] error during mongoose disconnect:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

// `require.main === module` is the canonical CJS check for "invoked
// from CLI vs imported as a library". tsup builds CJS, so this works
// for the bin entry. Tests import the module and never reach this
// branch.
if (require.main === module) {
  startCollabServer().catch((err: unknown) => {
    console.error('[crowi:collab] fatal:', err);
    process.exit(1);
  });
}
