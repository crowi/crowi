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
import { createLogRecord } from 'src/util/logger';
import { writeFatal } from 'src/util/logger-sink';
import { createShutdownHandler, installProcessFatalHandlers } from 'src/util/process-boundary';

// load .env
dotenv.config();

// Installed before `new Crowi(...)` so both SIGINT/SIGTERM wrappers below
// are armed before init/start even begins. This does NOT catch a
// synchronous constructor failure (see `createCrowiOrExit`'s own doc
// comment) — only later async faults (init/start rejections, and any
// `uncaughtException`/`unhandledRejection` this process receives once
// running).
installProcessFatalHandlers();

/**
 * `new Crowi(...)` runs `validateEnv()` synchronously in the constructor
 * (e.g. a missing/invalid `SECRET_TOKEN`) and throws before any instance
 * exists — `crowi.exitOnError` below (an arrow property bound to `this`) is
 * unreachable for a construction-time failure, since there is no `this` yet,
 * and `installProcessFatalHandlers()` above does not help either: a
 * SYNCHRONOUS throw inside this `try` is caught right here and never
 * reaches Node's `uncaughtException` dispatch. Without this wrapper the
 * process would exit via Node's default uncaught-exception path instead,
 * which prints a raw stack but never the `@@crowi:fail` marker
 * `scripts/dev.mjs` watches for to tear the whole dev tree down — so a boot
 * failure here would otherwise leave `web` and the watched deps running
 * against a dead api.
 */
function createCrowiOrExit(): Crowi {
  try {
    return new Crowi(resolve(join(__dirname, '..')), process.env);
  } catch (err) {
    process.stdout.write(`${formatFailMarker('api', formatBootFailureReason(err))}\n`);
    return writeFatal(createLogRecord('error', 'crowi:process', 'fatal API startup error', { error: err }));
  }
}

const crowi = createCrowiOrExit();

// Graceful shutdown on SIGINT/SIGTERM — see `createShutdownHandler` in `util/process-boundary.ts`.
const shutdown = createShutdownHandler(crowi);
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

crowi.init().then(crowi.start).catch(crowi.exitOnError);
