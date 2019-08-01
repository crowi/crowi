'use strict'

import '@babel/polyfill'

const mongoose = require('mongoose')
const path = require('path')
const Crowi = require(path.join(ROOT_DIR, '/lib/crowi'))

beforeAll(async () => {
  const crowi = new Crowi(ROOT_DIR, {
    PORT: 13001,
    MONGO_URI: __MONGO_URI__,
    BASE_URL: 'http://localhost:13001',
    ...process.env,
  })
  await crowi.init()
  const app = crowi.getApp()

  global.crowi = crowi
  global.app = app
})

afterAll(async () => {
  await crowi.getMongo().disconnect()

  // delete model caches
  Object.keys(crowi.models).forEach(key => {
    delete mongoose.models[key]
    delete mongoose.modelSchemas[key]
  })
})

const testDBUtil = {
  async generateFixture(conn, model, fixture) {
    if (conn.readyState === 0) {
      throw new Error()
    }
    const Model = conn.model(model)
    return Promise.all(fixture.map(entity => new Model(entity).save()))
  },
}

global.mongoose = mongoose
global.testDBUtil = testDBUtil
