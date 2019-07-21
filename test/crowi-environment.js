const NodeEnvironment = require('jest-environment-node')
const MongodbMemoryServer = require('mongodb-memory-server').default
const path = require('path')
const mongoose = require('mongoose')
const Crowi = require(path.join(__dirname, '../lib/crowi'))
const ROOT_DIR = path.join(__dirname, '../')
const MODEL_DIR = path.join(__dirname, '../lib/models')

class CrowiEnvironment extends NodeEnvironment {
  constructor(config) {
    super(config)

    this.mongodb = new MongodbMemoryServer({ binary: { version: '3.6.13' } })
    this.crowi = null
  }

  async setup() {
    await super.setup()
    this.global.__MONGO_URI__ = await this.mongodb.getConnectionString()
    this.global.__MONGO_DB_NAME__ = await this.mongodb.getDbName()

    this.crowi = new Crowi(ROOT_DIR, {
      PORT: 13001,
      MONGO_URI: this.global.__MONGO_URI__,
      ...process.env
    })
    await this.crowi.init()

    this.global.crowi = this.crowi
    this.global.ROOT_DIR = ROOT_DIR
    this.global.MODEL_DIR = MODEL_DIR
  }

  async teardown() {
    await super.teardown()
    await this.crowi.getMongo().disconnect();
    await this.mongodb.stop()

    // delete model caches
    Object.keys(this.crowi.models).forEach(key => {
      //console.log('delete', key)
      delete mongoose.models[key]
      delete mongoose.modelSchemas[key]
    })

    this.crowi = null
  }
}

module.exports = CrowiEnvironment
