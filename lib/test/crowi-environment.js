require('regenerator-runtime/runtime')

const NodeEnvironment = require('jest-environment-node')
const { MongoMemoryServer } = require('mongodb-memory-server')
const path = require('path')
const ROOT_DIR = path.join(__dirname, '../..')
const MODEL_DIR = path.join(__dirname, '../models')

class CrowiEnvironment extends NodeEnvironment {
  async setup() {
    await super.setup()

    this.mongodb = await MongoMemoryServer.create({ binary: { version: '3.6.13' } })
    this.global.MONGO_URI = this.mongodb.getUri()
    this.global.MONGO_DB_NAME = await this.mongodb.instanceInfo.dbName

    this.global.ROOT_DIR = ROOT_DIR
    this.global.MODEL_DIR = MODEL_DIR
  }

  async teardown() {
    await super.teardown()
    await this.mongodb.stop()
  }
}

module.exports = CrowiEnvironment
