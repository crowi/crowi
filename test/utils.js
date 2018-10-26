'use strict'

const mongoUri = process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || process.env.MONGO_URI || null
const mongoose = require('mongoose')
const models = require(MODEL_DIR)
const Config = require(MODEL_DIR + '/config')
const crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env)

// Want fix...
crowi.config.crowi = { 'app:url': 'http://localhost:3000' }

mongoose.Promise = global.Promise

beforeAll(async () => {
  if (mongoUri) {
    await mongoose.connect(mongoUri)
    await mongoose.connection.db.dropDatabase()
  }
})

afterAll(async () => {
  if (mongoUri) {
    await mongoose.disconnect()
  }
})

// Setup Models
models.Config = Config
for (let [modelName, model] of Object.entries(models)) {
  models[modelName] = model(crowi)
}
crowi.models = models

// create dummy Socket.IO server
crowi.getIo = function() {
  return {
    sockets: {
      emit: function(str, obj) {},
    },
  }
}

module.exports = {
  models,
  mongoose,
}
