const NodeEnvironment = require('jest-environment-node')
const MongodbMemoryServer = require('mongodb-memory-server').default

class MongoDbEnvironment extends NodeEnvironment {
  constructor(config) {
    super(config)
    this.mongodb = new MongodbMemoryServer({ binary: { version: '3.6.3' } })
  }

  async setup() {
    await super.setup()
    this.global.__MONGO_URI__ = await this.mongodb.getConnectionString()
    this.global.__MONGO_DB_NAME__ = await this.mongodb.getDbName()
  }

  async teardown() {
    await super.teardown()
    await this.mongodb.stop()
  }
}

module.exports = MongoDbEnvironment
