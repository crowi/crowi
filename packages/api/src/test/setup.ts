import Crowi from 'src/crowi';
import { Express } from 'express';

// Silence boot-time noise that fires once per test file and drowns
// the actual ✓ / ✕ output in the jest report:
//
//   `[crowi] Loaded N plugin(s): ...`         — PluginManager boot log
//   `[crowi] CROWI_ENCRYPTION_KEY is not set` — setupEncryption legacy
//                                               fallback (the test env
//                                               injects a dummy key,
//                                               but tests that delete
//                                               the env still trip it)
//   `[crowi] Migrated N legacy ...`           — one-shot config migrator
//
// We patch console.log + console.warn once at module load so every
// test file inherits the filter without per-test setup. Production
// boot still emits everything.
{
  const QUIET_PREFIXES = ['[crowi] '];
  const isQuiet = (args: unknown[]) => typeof args[0] === 'string' && QUIET_PREFIXES.some((prefix) => (args[0] as string).startsWith(prefix));

  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    if (isQuiet(args)) return;
    originalLog(...args);
  };

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (isQuiet(args)) return;
    originalWarn(...args);
  };
}

export let crowi: Crowi;
export let app: Express;

// @ts-ignore
export const ROOT_DIR = global.ROOT_DIR as string;
// @ts-ignore
export const MODEL_DIR = global.MODEL_DIR as string;
// @ts-ignore
export const MONGO_URI = global.MONGO_URI as string;
// @ts-ignore
export const MONGO_DB_NAME = global.MONGO_DB_NAME as string;

beforeAll(async () => {
  // Spread process.env FIRST and then layer the test-harness values on
  // top. The original order (`{ ...test, ...process.env }`) silently
  // let an externally-set `MONGO_URI` (e.g. the CI's `mongodb://
  // localhost:27017` from the docker `mongo` service) override the
  // crowi-environment.js per-file db, which collapses every parallel
  // jest worker onto a single shared database and recycles Config
  // documents from previous runs across test files.
  crowi = new Crowi(ROOT_DIR, {
    ...process.env,
    PORT: '13001',
    MONGO_URI: MONGO_URI,
    BASE_URL: 'http://localhost:13001',
  });
  await crowi.init();
  app = crowi.getApp();
});

afterAll(async () => {
  await crowi.getMongo().disconnect();
});

export const Fixture = {
  async generate(model, fixture) {
    const conn = crowi.getMongo().connection;
    if (conn.readyState === 0) {
      throw new Error();
    }
    const Model = conn.model(model);
    return Promise.all(fixture.map((entity) => new Model(entity).save()));
  },
};
