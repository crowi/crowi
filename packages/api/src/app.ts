#!/usr/bin/env node
/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import dotenv from 'dotenv';
import { join, resolve } from 'path';
import Crowi from 'src/crowi';
import { formatBootFailureReason, formatFailMarker } from 'src/util/boot-reporter';

// load .env
dotenv.config();

/**
 * `new Crowi(...)` runs `validateEnv()` synchronously in the constructor
 * (e.g. a missing/invalid `SECRET_TOKEN` — feature-unified-signing-secret
 * §D-2) and throws before any instance exists — `crowi.exitOnError` below
 * (an arrow property bound to `this`) is unreachable for a construction-time
 * failure, since there is no `this` yet. Without this wrapper the process
 * exits via Node's default uncaught-exception path, which prints a raw
 * stack but never the `@@crowi:fail` marker `scripts/dev.mjs` watches for
 * to tear the whole dev tree down — so a boot failure here would otherwise
 * leave `web` and the watched deps running against a dead api.
 */
function createCrowiOrExit(): Crowi {
  try {
    return new Crowi(resolve(join(__dirname, '..')), process.env);
  } catch (err) {
    process.stdout.write(`${formatFailMarker('api', formatBootFailureReason(err))}\n`);
    console.error(err);
    process.exit(1);
  }
}

const crowi = createCrowiOrExit();

crowi.init().then(crowi.start).catch(crowi.exitOnError);

/**
 * RFC-0003 — graceful shutdown for the embedded Hocuspocus engine.
 *
 * Two routes can fire the teardown:
 *   - `SIGINT` (Ctrl-C in dev / orchestrator stop)
 *   - `SIGTERM` (docker stop / systemd / k8s)
 *
 * `shutdown()` flushes pending Y.Doc checkpoints before dropping
 * connections — without this hook, an unsaved-debounce window's worth
 * of edits would be lost on every process restart. We defer the actual
 * `process.exit` to Node's default behaviour after the handler resolves
 * so any other registered shutdown logic still runs.
 */
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[crowi] ${signal} received — shutting down`);
  try {
    await crowi.collabAttachment?.shutdown();
  } catch (err) {
    console.error('[crowi] collabAttachment.shutdown failed:', err);
  }
  try {
    await crowi.presenceAttachment?.shutdown();
  } catch (err) {
    console.error('[crowi] presenceAttachment.shutdown failed:', err);
  }
  try {
    await crowi.notificationsAttachment?.shutdown();
  } catch (err) {
    console.error('[crowi] notificationsAttachment.shutdown failed:', err);
  }
  process.exit(0);
};
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
