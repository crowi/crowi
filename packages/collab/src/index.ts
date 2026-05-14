#!/usr/bin/env node
import dotenv from 'dotenv';
import Debug from 'debug';
import { loadCollabEnv } from './env';
import { connectMongo, disconnectMongo } from './db';
import { registerModels } from './models';
import { createCollabServer } from './server';
import { getWsTokenUtil } from './ws-token';
import { createCollabPageEventPublisher } from './page-event-pubsub';

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
 *      exact same schema definitions, **and** builds the renderer in
 *      the same call so `Revision.prepareRevision` works from the save
 *      flow. Plugin transforms aren't loaded (see models.ts).
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

  const { models, renderer } = registerModels();
  // Warmup the renderer in the background. Shiki / unified ESM loading
  // can take 100-500ms on first use; firing this here means the first
  // save isn't slowed by lazy init. Errors are warn-only so a warmup
  // failure can't keep the collab server from accepting connections.
  void renderer.warmup?.().catch((err) => debug('renderer.warmup failed (non-fatal):', err));

  const wsTokenUtil = getWsTokenUtil();

  // Phase 5 cross-process pageEvent publisher (api side runs the
  // subscriber). No-op publisher when REDIS_URL is unset — collab
  // still boots; api just won't observe collab-initiated saves on a
  // remote instance.
  const pageEventPublisher = await createCollabPageEventPublisher({
    redisUrl: process.env.REDIS_TLS_URL ?? process.env.REDIS_URL ?? null,
    redisRejectUnauthorized: process.env.REDIS_REJECT_UNAUTHORIZED !== '0',
  });

  const server = createCollabServer({
    models,
    wsTokenUtil,
    port: env.port,
    address: env.address,
    quiet: env.quiet,
    pageEventPublisher,
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
      // Disconnect the page-event publisher BEFORE mongoose so any
      // in-flight publish that was queued at shutdown gets a chance
      // to flush. Failures are warned (not thrown) inside the helper.
      await pageEventPublisher.disconnect();
    } catch (err) {
      console.error('[crowi:collab] error during pageEventPublisher.disconnect():', err);
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
