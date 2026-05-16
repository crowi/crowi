#!/usr/bin/env node
/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import dotenv from 'dotenv';
import Crowi from 'src/crowi';
import { join, resolve } from 'path';

// load .env
dotenv.config();

const crowi = new Crowi(resolve(join(__dirname, '..')), process.env);

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
  process.exit(0);
};
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
