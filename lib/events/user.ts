import Crowi from 'server/crowi'
import { EventEmitter } from 'events'
import Debug from 'debug'
const debug = Debug('crowi:events:user')

export default class UserEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }

  async onActivated(user) {
    const Page = this.crowi.model('Page')

    const userPagePath = Page.getUserPagePath(user)
    Page.findPage(userPagePath, user, {}, false)
      .then(function(page) {
        // do nothing because user page is already exists.
      })
      .catch(function(err) {
        const body = `# ${user.username}\nThis is ${user.username}'s page`
        // create user page
        Page.createPage(userPagePath, body, user, {})
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
