'use strict'

const mongoUri = process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || process.env.MONGO_URI || null
const mongoose = require('mongoose')
const fs = require('fs')
const models = {}
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
fs.readdirSync(MODEL_DIR).forEach(function(file) {
  if (file.match(/^(\w+)\.js$/)) {
    const name = RegExp.$1
    if (name === 'index') {
      return
    }
    const modelName = name.charAt(0).toUpperCase() + name.slice(1)
    models[modelName] = require(MODEL_DIR + '/' + file)(crowi)
  }
})

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
  models: models,
  mongoose: mongoose,
}
