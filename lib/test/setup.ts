import '@babel/polyfill'

import Crowi from 'server/crowi'
import { Express } from 'express'

export let crowi: Crowi
export let app: Express

// @ts-ignore
export const ROOT_DIR = global.ROOT_DIR as string
// @ts-ignore
export const MODEL_DIR = global.MODEL_DIR as string
// @ts-ignore
export const MONGO_URI = global.MONGO_URI as string
// @ts-ignore
export const MONGO_DB_NAME = global.MONGO_DB_NAME as string

beforeAll(async () => {
  crowi = new Crowi(ROOT_DIR, {
    PORT: '13001',
    MONGO_URI: MONGO_URI,
    BASE_URL: 'http://localhost:13001',
    ...process.env,
  })
  await crowi.init()
  app = crowi.getApp()
})

afterAll(async () => {
  await crowi.getMongo().disconnect()
})

export const Fixture = {
  async generate(model, fixture) {
    const conn = crowi.getMongo().connection
    if (conn.readyState === 0) {
      throw new Error()
    }
    const Model = conn.model(model)
    return Promise.all(fixture.map((entity) => new Model(entity).save()))
  },
}
