import { EventEmitter } from 'node:events';
import Debug from 'debug';
import Crowi from 'src/crowi';
import { UserDocument } from 'src/models/user';
import { drainUserActivation } from 'src/services/auth-registration';

const debug = Debug('crowi:events:user');

export default class UserEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
  }

  async onActivated(user: UserDocument) {
    // RFC-0014 phase 2 — a federated JIT registration already created a
    // durable `UserActivation` marker for this user BEFORE this event could
    // ever fire (Restricted mode: the marker is created at submit time; the
    // 'activated' event only fires later, when an admin approves via
    // `user.statusActivate()`). When one exists, `drainUserActivation` — not
    // the legacy rename-and-recreate below — owns the page side effect, so
    // a pre-existing manual page is never renamed for these users. A user
    // with no marker (every non-federated activation path) is unaffected.
    const UserActivation = this.crowi.model('UserActivation');
    const marker = await UserActivation.findOne({ userId: user._id });
    if (marker) {
      await drainUserActivation(this.crowi, user._id);
      return;
    }

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
