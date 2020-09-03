import Crowi from 'server/crowi'
import { EventEmitter } from 'events'
import Debug from 'debug'
import { UserDocument } from 'server/models/user'

const debug = Debug('crowi:events:user')

export default class UserEvent extends EventEmitter {
  public crowi: Crowi

  constructor(crowi: Crowi) {
    super()
    this.crowi = crowi
  }

  async onActivated(user: UserDocument) {
    const Page = this.crowi.model('Page')
    const userPagePath = Page.getUserPagePath(user)
    const page = await Page.findPage(userPagePath, user, {}, true)

    // User page created manually is already exists.
    if (page !== null) {
      const renamedUserPagePath = `/tmp/user-${user.username}-${Date.now()}`
      await Page.rename(page, renamedUserPagePath, user, {})
    }

    await this.createUserPage(userPagePath, user)
  }

  private async createUserPage(userPagePath: string, user: UserDocument) {
    const Page = this.crowi.model('Page')
    const body = `# ${user.username}\nThis is ${user.username}'s page`

    try {
      const page = await Page.createPage(userPagePath, body, user, {})
      debug('User page created', page)
    } catch (err) {
      debug('Failed to create user page', err)
    }
  }
}
