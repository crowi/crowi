'use strict'

const mongoose = require('mongoose')
const models = require(MODEL_DIR)
const Config = require(MODEL_DIR + '/config')
const crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env)

mongoose.Promise = global.Promise

const { __MONGO_URI__: MONGO_URI } = global

beforeAll(async () => {
  if (MONGO_URI) {
    await mongoose.connect(MONGO_URI)
    await mongoose.connection.dropDatabase()
  }
})

afterAll(async () => {
  if (MONGO_URI) {
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

// FIXME: Mock. Should be changed to use a real Crowi object.
crowi.config = {
  data: {
    crowi: { 'app:url': 'http://localhost:3000' },
  },
  set(config) {
    this.data = config
  },
  get() {
    return this.data
  },
}

module.exports = {
  models,
  mongoose,
}
