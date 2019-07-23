const NodeEnvironment = require('jest-environment-node')
const MongodbMemoryServer = require('mongodb-memory-server').default
const path = require('path')
const ROOT_DIR = path.join(__dirname, '../')
const MODEL_DIR = path.join(__dirname, '../lib/models')

class CrowiEnvironment extends NodeEnvironment {
  constructor(config) {
    super(config)

    this.mongodb = new MongodbMemoryServer({ binary: { version: '3.6.13' } })
  }

  async setup() {
    await super.setup()
    this.global.__MONGO_URI__ = await this.mongodb.getConnectionString()
    this.global.__MONGO_DB_NAME__ = await this.mongodb.getDbName()

    this.global.ROOT_DIR = ROOT_DIR
    this.global.MODEL_DIR = MODEL_DIR
  }

  async teardown() {
    await super.teardown()
    await this.mongodb.stop()
  }
}

module.exports = CrowiEnvironment
