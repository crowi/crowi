'use strict'

import '@babel/polyfill'

const mongoose = require('mongoose')
const path = require('path')
const Crowi = require(path.join(ROOT_DIR, '/lib/crowi'))

beforeAll(async done => {
  const crowi = new Crowi(ROOT_DIR, {
    PORT: 13001,
    MONGO_URI: __MONGO_URI__,
    ...process.env,
  })
  await crowi.init()
  const app = crowi.getApp()

  global.crowi = crowi
  global.app = app

  done()
})

afterAll(async done => {
  await crowi.getMongo().disconnect()

  // delete model caches
  Object.keys(crowi.models).forEach(key => {
    // console.log('delete', key)
    delete mongoose.models[key]
    delete mongoose.modelSchemas[key]
  })

  done()
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
