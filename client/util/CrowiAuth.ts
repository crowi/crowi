import queryString from 'query-string'

export default class CrowiAuth {
  constructor(crowi) {
    this.crowi = crowi
    this.location = crowi.location
    this.localStorage = crowi.localStorage

    this.onStorage = this.onStorage.bind(this)

    this.subscribeStorage()
    this.updateState()
  }

  isAuthenticated() {
    const { id, name } = this.crowi.getUser()
    return !!(id && name)
  }

  subscribeStorage() {
    window.addEventListener('storage', this.onStorage)
  }

  shouldUpdate() {
    return this.isAuthenticated() !== this.localStorage.getItem('authenticated')
  }

  updateState() {
    if (this.shouldUpdate()) {
      this.localStorage.setItem('authenticated', this.isAuthenticated())
    }
  }

  onStorage(e) {
    const { key, newValue } = e
    const isAuthenticated = newValue === 'true'
    if (key === 'authenticated') {
      if (isAuthenticated) {
        this.onLogin()
      } else {
        this.onLogout()
      }
    }
  }

  onLogin() {
    const { continue: continueUrl = '/' } = queryString.parse(this.location.search)
    top.location.href = continueUrl
  }

  onLogout() {
    this.location.reload()
  }
}
