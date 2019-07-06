'use strict'

const debug = require('debug')('crowi:util:accessTokenParser')

/**
 * Extract Bearer token from Authorization header.
 *
 * @param {Object} headers HTTP request headers
 * @param {string} headers.authorization Authorization header value.
 * @return {?string} found access_token or null.
 */
const extractBearerToken = headers => {
  const v = headers.authorization
  debug('Authorization', v)
  if (!v) {
    return null
  }

  const parts = v
    .trim()
    .replace(/( )+/g, ' ')
    .split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null
  }

  return parts[1]
}

module.exports = {
  parseAccessToken: req => {
    if (!req) {
      throw new Error('req required.')
    }

    return extractBearerToken(req.headers) || req.query.access_token || req.body.access_token || null
  },
}
