'use strict'

const express = require('express')
const path = require('path')
const ROOT_DIR = path.join(__dirname, './..')
const MODEL_DIR = path.join(__dirname, './../lib/models')

const testDBUtil = {
  generateFixture: function(conn, model, fixture) {
    if (conn.readyState == 0) {
      return Promise.reject(new Error())
    }
    const Model = conn.model(model)

    return new Promise(function(resolve, reject) {
      var createdModels = []
      fixture
        .reduce(function(promise, entity) {
          return promise.then(function() {
            const newDoc = new Model()

            Object.keys(entity).forEach(function(k) {
              newDoc[k] = entity[k]
            })
            return new Promise(function(resolve, reject) {
              newDoc.save(function(err, data) {
                createdModels.push(data)
                return resolve()
              })
            })
          })
        }, Promise.resolve())
        .then(function() {
          resolve(createdModels)
        })
    })
  },
}

global.express = express
global.ROOT_DIR = ROOT_DIR
global.MODEL_DIR = MODEL_DIR
global.testDBUtil = testDBUtil
