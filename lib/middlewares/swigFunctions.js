const functions = require('../util/swigFunctions')

module.exports = (crowi, app) => {
  return (req, res, next) => {
    functions(crowi, app, req, res.locals)
    next()
  }
}
