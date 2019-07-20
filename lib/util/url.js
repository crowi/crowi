'use strict'

const getContinueUrl = (req = {}) => {
  const { body = {}, query = {} } = req
  const url = body.continue || query.continue
  const continueUrl = /^(?![/\\]{2,})\/.*$/.test(url) ? url : '/'

  return continueUrl
}

module.exports = { getContinueUrl }
