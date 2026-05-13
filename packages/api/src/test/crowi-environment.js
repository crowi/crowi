require('regenerator-runtime/runtime');
const NodeEnvironment = require('jest-environment-node').default || require('jest-environment-node');
const path = require('path');
const { randomBytes } = require('node:crypto');

const ROOT_DIR = path.join(__dirname, '../..');
const MODEL_DIR = path.join(__dirname, '../models');

/**
 * jest environment for the @crowi/api server-side test project.
 *
 * Resolution order for the test MongoDB:
 *
 *   1. `process.env.MONGO_URI` is set → connect to that MongoDB
 *      (CI uses `services: mongo` on the GitHub Actions runner; local
 *      developers can point this at the `docker compose up -d` mongo).
 *      Each test file gets its own database under that server so jest
 *      can run `--maxWorkers=N` in parallel without collisions, and
 *      teardown drops the per-file db so the shared server stays
 *      clean across runs.
 *
 *   2. Otherwise → `mongodb-memory-server` is started in-process.
 *      This is the "no infrastructure" fallback for local
 *      `pnpm test` invocations on machines without the docker stack
 *      running. Each environment instance gets its own memory-server
 *      so there's no inter-file state.
 *
 * Why per-test-file dbs instead of one shared db plus collection
 * clears: jest constructs a fresh `CrowiEnvironment` per test file
 * and `crowi.init()` registers mongoose models against the global
 * connection. Sharing a db across files lets one file's leftover
 * documents leak into the next file's `Model.find()` expectations.
 * Worker-scoped dbs aren't enough either — a single worker runs
 * many files serially. Random hex suffix per environment instance
 * is the cheapest way to guarantee isolation.
 */
class CrowiEnvironment extends NodeEnvironment {
  async setup() {
    await super.setup();

    // Provide a stable encryption key for the test environment so
    // (a) the boot path's "legacy mode" warning doesn't spam test
    // output, and (b) sensitive Config round-trips exercise the
    // real encrypt/decrypt code path rather than the plaintext
    // fallback. Tests that specifically need the unconfigured state
    // (e.g. `crypto.test.ts`) save `originalKey`, mutate, and
    // restore — so providing a default here is safe.
    //
    // Mutate `this.global.process.env`, NOT the host's `process.env`:
    // jest-environment-node hands the test vm context a `process` that
    // doesn't share its `env` proxy with the worker host, so an
    // assignment to host `process.env` here is invisible to the test
    // code that boots `Crowi` from within the vm.
    if (!this.global.process.env.CROWI_ENCRYPTION_KEY) {
      this.global.process.env.CROWI_ENCRYPTION_KEY = Buffer.alloc(32, 0xab).toString('base64');
    }

    const workerId = process.env.JEST_WORKER_ID || '1';
    const suffix = randomBytes(4).toString('hex');
    const dbName = `crowi_test_${workerId}_${suffix}`;

    const externalUri = process.env.MONGO_URI;
    if (externalUri && externalUri.trim()) {
      // Strip any trailing path / db / query on the supplied URI and
      // splice in our per-file db name. `mongodb://localhost:27017/foo?bar`
      // becomes `mongodb://localhost:27017/crowi_test_<id>?bar`.
      const url = new URL(externalUri);
      url.pathname = `/${dbName}`;
      this.mongoUri = url.toString();
      this.dbName = dbName;
      this.usingMemoryServer = false;
    } else {
      // memory-server fallback. Pin to 8.0.4 so the binary matches the
      // `mongo:8.0.4` docker image used in CI's `services` block — keeps
      // wire-protocol + index behaviour byte-identical between the two
      // execution paths so we don't get "passes locally, fails in CI"
      // mismatches from minor MongoDB version drift.
      const { MongoMemoryServer } = require('mongodb-memory-server');
      this.memory = await MongoMemoryServer.create({ binary: { version: '8.0.4' } });
      const url = new URL(this.memory.getUri());
      url.pathname = `/${dbName}`;
      this.mongoUri = url.toString();
      this.dbName = dbName;
      this.usingMemoryServer = true;
    }

    this.global.MONGO_URI = this.mongoUri;
    this.global.MONGO_DB_NAME = this.dbName;
    this.global.ROOT_DIR = ROOT_DIR;
    this.global.MODEL_DIR = MODEL_DIR;
  }

  async teardown() {
    // Drop the per-file db on a shared (docker / CI) server so the
    // mongo instance doesn't accumulate stale dbs across runs. Use
    // mongoose since the api package already depends on it — avoids
    // adding a direct `mongodb` driver dependency just for cleanup.
    // Best-effort: if setup() bailed before connection, just skip.
    if (this.mongoUri) {
      try {
        const mongoose = require('mongoose');
        const conn = await mongoose.createConnection(this.mongoUri).asPromise();
        await conn.dropDatabase();
        await conn.close();
      } catch (_err) {
        // Cleanup failure is non-fatal; memory-server stop below
        // handles ephemeral storage, and a stale db on the shared
        // server only costs disk until the next run drops it.
      }
    }
    if (this.usingMemoryServer && this.memory) {
      await this.memory.stop();
    }
    await super.teardown();
  }
}

module.exports = CrowiEnvironment;
