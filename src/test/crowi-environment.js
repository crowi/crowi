require('regenerator-runtime/runtime')
const NodeEnvironment = require('jest-environment-node').default || require('jest-environment-node')
const { MongoMemoryServer } = require('mongodb-memory-server')
const path = require('path')
const ROOT_DIR = path.join(__dirname, '../..')
const MODEL_DIR = path.join(__dirname, '../models')

class CrowiEnvironment extends NodeEnvironment {
  constructor(config) {
    super(config)
  }

  async setup() {
    await super.setup()
    this.mongodb = await MongoMemoryServer.create({ binary: { version: '6.0.16' } })
    this.global.MONGO_URI = this.mongodb.getUri()
    const dbName = this.mongodb.getUri().split('/').pop().split('?')[0]
    this.global.MONGO_DB_NAME = dbName || 'test'

    this.global.ROOT_DIR = ROOT_DIR
    this.global.MODEL_DIR = MODEL_DIR
  }

  async teardown() {
    await super.teardown()
    await this.mongodb.stop()
  }
}

module.exports = CrowiEnvironment
