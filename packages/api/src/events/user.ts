import { EventEmitter } from 'node:events';
import Debug from 'debug';
import Crowi from 'src/crowi';
import { UserDocument } from 'src/models/user';

const debug = Debug('crowi:events:user');

export default class UserEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
  }

  async onActivated(user: UserDocument) {
    const Page = this.crowi.model('Page');
    const userPagePath = Page.getUserPagePath(user);
    const page = await Page.findPage(userPagePath, user, {}, true);

    // User page created manually is already exists.
    if (page !== null) {
      const renamedUserPagePath = `/tmp/user-${user.username}-${Date.now()}`;
      // RFC-0017 Phase 1 §D7 — this is an internal repair rename (moving a
      // pre-existing manual page out of the way so the real user home page
      // can be created), not a user-requested rename: suppress its
      // `page-renamed` prompt. The epoch still advances unconditionally.
      await Page.rename(page, renamedUserPagePath, user, { invalidation: { mode: 'skip', reason: 'user-activation' } });
    }

    await this.createUserPage(userPagePath, user);
  }

  private async createUserPage(userPagePath: string, user: UserDocument) {
    const Page = this.crowi.model('Page');
    const body = `# ${user.username}\nThis is ${user.username}'s page`;

    try {
      const page = await Page.createPage(userPagePath, body, user, {});
      debug('User page created', page);
    } catch (err) {
      debug('Failed to create user page', err);
    }
  }
}
