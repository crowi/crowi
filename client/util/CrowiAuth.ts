import Crowi from './Crowi'
import queryString from 'query-string'

export default class CrowiAuth {
  crowi: Crowi
  location: Crowi['location']
  localStorage: Crowi['localStorage']

  constructor(crowi: Crowi) {
    this.crowi = crowi
    this.location = crowi.location
    this.localStorage = crowi.localStorage

    this.onStorage = this.onStorage.bind(this)

    this.subscribeStorage()
    this.updateState()
  }

  isAuthenticated(): boolean {
    const { id = '', name = '' } = this.crowi.getUser() || {}
    return !!(id && name)
  }

  subscribeStorage() {
    window.addEventListener('storage', this.onStorage)
  }

  shouldUpdate(): boolean {
    return String(this.isAuthenticated()) !== this.localStorage.getItem('authenticated')
  }

  updateState() {
    if (this.shouldUpdate()) {
      this.localStorage.setItem('authenticated', String(this.isAuthenticated()))
    }
  }

  onStorage(e: StorageEvent) {
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
    top.location.href = typeof continueUrl === 'string' ? continueUrl : '/'
  }

  onLogout() {
    this.location.reload()
  }
}
