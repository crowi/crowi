/**
 * Custom errors
 */

const generateCustomError = (name) => class extends Error {
  constructor (...args) {
    super(...args)
    this.name = name
  }
}

module.exports = {
  ValidateTeamError: generateCustomError('ValidateTeamError')
}
