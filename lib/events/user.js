const debug = require('debug')('crowi:events:user')
const { EventEmitter } = require('events')

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
        const body = `# ${user.username}\nThis is ${user.username}'s page`
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
