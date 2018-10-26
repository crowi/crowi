'use strict'

var mongoUri = process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || process.env.MONGO_URI || 'mongodb://localhost/crowi'
var mongoose = require('mongoose')
var fs = require('fs')
var models = {}
var crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env)

// Want fix...
crowi.config.crowi = { 'app:url': 'http://localhost:3000' }

mongoose.Promise = global.Promise

before('Create database connection and clean up', function(done) {
  if (!mongoUri) {
    return done()
  }
const { MongoClient } = require('mongodb')

mongoose.Promise = global.Promise

before('Drop database before all tests', async function() {
  const db = await MongoClient.connect(mongoUri)
  await db.dropDatabase()
  db.close()

  await mongoose.connect(mongoUri)
})

after('Close database connection', function(done) {
  if (!mongoUri) {
    return done()
  }

  mongoose.disconnect()
  return done()
})

// Setup Models
fs.readdirSync(MODEL_DIR).forEach(function(file) {
  if (file.match(/^(\w+)\.js$/)) {
    var name = RegExp.$1
    if (name === 'index') {
      return
    }
    var modelName = name.charAt(0).toUpperCase() + name.slice(1)
    models[modelName] = require(MODEL_DIR + '/' + file)(crowi)
  }
})

crowi.models = models

module.exports = {
  models: models,
  mongoose: mongoose,
  errors: crowi.errors,
}
