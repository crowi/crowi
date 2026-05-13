import Crowi from 'src/crowi';
import { Express } from 'express';

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
