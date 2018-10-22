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

const errorNames = ['PermissionError']
module.exports = errorNames.reduce((errors, name) => {
  errors[name] = createCustomErrorClass(name)
  return errors
}, {})
