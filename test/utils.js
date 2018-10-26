'use strict'

const mongoUri = process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || process.env.MONGO_URI || null
const mongoose = require('mongoose')
const fs = require('fs')
const models = {}
const crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env)

// Want fix...
crowi.config.crowi = { 'app:url': 'http://localhost:3000' }

mongoose.Promise = global.Promise

beforeAll(function(done) {
  if (!mongoUri) {
    return done()
  }

  mongoose.connect(mongoUri)

  function clearDB() {
    for (var i in mongoose.connection.collections) {
      mongoose.connection.collections[i].remove(function() {})
    }
    return done()
  }

  if (mongoose.connection.readyState === 0) {
    mongoose.connect(
      mongoUri,
      function(err) {
        if (err) {
          throw err
        }
        return clearDB()
      },
    )
  } else {
    return clearDB()
  }
})

afterAll(function(done) {
  if (!mongoUri) {
    return done()
  }

  mongoose.disconnect()
  return done()
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
