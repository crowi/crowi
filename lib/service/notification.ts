import Crowi from 'server/crowi'

export default class Notification {
  crowi: Crowi

  config: any

  constructor(crowi: Crowi) {
    this.crowi = crowi
    this.config = crowi.getConfig()
  }

  hasSlackConfig() {
    if (!this.config.notification.slack) {
      return false
    }
  }

  noitfyByEmail() {}

  noitfyByChat() {}
}
