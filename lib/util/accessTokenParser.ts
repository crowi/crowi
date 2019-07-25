import Debug from 'debug'

const debug = Debug('crowi:util:accessTokenParser')

/**
 * Extract Bearer token from Authorization header.
 *
 * @param {Object} headers HTTP request headers
 * @param {string} headers.authorization Authorization header value.
 * @return {?string} found access_token or null.
 */
const extractBearerToken = headers => {
  const v = headers.authorization
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

export const parseAccessToken = req => {
  if (!req) {
    throw new Error('req required.')
  }

  return extractBearerToken(req.headers) || req.query.access_token || req.body.access_token || null
}
