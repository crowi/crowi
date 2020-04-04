import Crowi from './Crowi'
import queryString from 'query-string'

export default class CrowiAuth {
  crowi: Crowi

  window: Window

  location: Crowi['location']

  localStorage: Crowi['localStorage']

  constructor(crowi: Crowi) {
    this.crowi = crowi
    this.window = crowi.window
    this.location = crowi.location
    this.localStorage = crowi.localStorage

    this.onStorage = this.onStorage.bind(this)

    this.subscribeStorage()
    this.updateState()
  }

  isAuthenticated(): boolean {
    const { _id } = this.crowi.getUser()
    return !!_id
  }

  subscribeStorage() {
    this.window.addEventListener('storage', this.onStorage)
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
    if (continueUrl) {
      top.location.href = typeof continueUrl === 'string' ? continueUrl : '/'
    } else {
      this.location.reload()
    }
  }

  onLogout() {
    this.location.reload()
  }
}
