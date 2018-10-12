const debug = require('debug')('crowi:events:user')
const { EventEmitter } = require('events')
const sprintf = require('sprintf')

class UserEvent extends EventEmitter {
  constructor(crowi) {
    super()
    this.crowi = crowi
  }
  onActivated(user) {
    const Page = this.crowi.model('Page')

    const userPagePath = Page.getUserPagePath(user)
    Page.findPage(userPagePath, user, {}, false)
      .then(function(page) {
        // do nothing because user page is already exists.
      })
      .catch(function(err) {
        const body = sprintf("# %s\nThis is %s's page", user.username, user.username)
        // create user page
        Page.create(userPagePath, body, user, {})
          .then(function(page) {
            // page created
            debug('User page created', page)
          })
          .catch(function(err) {
            debug('Failed to create user page', err)
          })
      })
  }
}

module.exports = UserEvent
