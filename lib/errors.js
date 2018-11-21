/**
 * Custom errors
 */

const createCustomErrorClass = name =>
  class extends Error {
    constructor(...args) {
      super(...args)
      this.name = name
    }
  }

const errorNames = ['PreconditionError']
module.exports = errorNames.reduce((errors, name) => {
  errors[name] = createCustomErrorClass(name)
  return errors
}, {})
