const { encodeSpace } = require('../util/path')

module.exports = (crowi, app) => {
  return (req, res, next) => {
    const path = decodeURIComponent(req.originalUrl || '')
    const encodedPath = encodeSpace(path)

    if (path !== encodedPath) {
      return res.redirect(encodedPath)
    }

    return next()
  }
}
