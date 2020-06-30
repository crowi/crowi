/**
 * Crowi context class for client
 */

import axios from 'axios'
import io from 'socket.io-client'
import { User } from 'client/types/crowi'
import { AppContext } from 'server/types/appContext'

export type Me = AppContext['user']

export default class Crowi {
  public context: AppContext

  public window: Window

  public location: Location

  public document: Document

  public localStorage: Storage

  public users: User[]

  public userByName: { [name: string]: User }

  public userById: { [id: string]: User }

  public draft: { [path: string]: string }

  public socket: any

  constructor(context: AppContext, window: Window) {
    this.context = context

    this.window = window
    this.location = window.location || {}
    this.document = window.document || {}
    this.localStorage = window.localStorage || {}

    this.fetchUsers = this.fetchUsers.bind(this)
    this.apiGet = this.apiGet.bind(this)
    this.apiPost = this.apiPost.bind(this)
    this.apiRequest = this.apiRequest.bind(this)

    this.users = []
    this.userByName = {}
    this.userById = {}
    this.draft = {}

    this.recoverData()

    this.socket = io({
      transports: ['websocket'],
    })
  }

  getContext() {
    return this.context
  }

  getConfig() {
    return this.context.config
  }

  getUser() {
    return this.context.user
  }

  getWebSocket() {
    return this.socket
  }

  recoverData() {
    type keys = ['userByName', 'userById', 'users', 'draft']
    const keys: keys = ['userByName', 'userById', 'users', 'draft']

    keys.forEach((key) => {
      const keyContent = this.localStorage[key]
      if (keyContent) {
        try {
          this[key] = JSON.parse(keyContent)
        } catch (e) {
          this.localStorage.removeItem(key)
        }
      }
    })
  }

  fetchUsers() {
    const interval = 1000 * 60 * 15 // 15min
    const currentTime = new Date().getTime()
    const lastFetched = new Date(this.localStorage.lastFetched || 0).getTime()
    if (interval > currentTime - lastFetched) {
      return
    }

    this.apiGet('/users.list', {})
      .then((data) => {
        this.users = data.users
        this.localStorage.users = JSON.stringify(data.users)

        const userByName: { [name: string]: User } = {}
        const userById: { [id: string]: User } = {}
        data.users.forEach((user: User) => {
          const { username, _id } = user
          userByName[username] = user
          userById[_id] = user
        })
        this.userByName = userByName
        this.localStorage.userByName = JSON.stringify(userByName)

        this.userById = userById
        this.localStorage.userById = JSON.stringify(userById)

        this.localStorage.lastFetched = new Date()
      })
      .catch((err) => {
        this.localStorage.removeItem('lastFetched')
        // ignore errors
      })
  }

  clearDraft(path: string) {
    delete this.draft[path]
    this.localStorage.draft = JSON.stringify(this.draft)
  }

  saveDraft(path: string, body: string) {
    this.draft[path] = body
    this.localStorage.draft = JSON.stringify(this.draft)
  }

  findDraft(path: string) {
    if (this.draft && this.draft[path]) {
      return this.draft[path]
    }

    return null
  }

  findUserById(userId: string) {
    if (this.userById && this.userById[userId]) {
      return this.userById[userId]
    }

    return null
  }

  findUserByIds(userIds: string[]) {
    const users: User[] = []
    for (const userId of userIds) {
      const user = this.findUserById(userId)
      if (user) {
        users.push(user)
      }
    }

    return users
  }

  findUser(username: string) {
    if (this.userByName && this.userByName[username]) {
      return this.userByName[username]
    }

    return null
  }

  async apiGet(path: string, params = {}) {
    return this.apiRequest('get', path, { params })
  }

  async apiPost(path: string, data: { _csrf?: string; [key: string]: any } = {}) {
    if (!data._csrf) {
      data._csrf = this.context.csrfToken
    }

    return this.apiRequest('post', path, { data })
  }

  async apiRequest(method: 'get' | 'post', path: string, payload: { params?: any; data?: any }) {
    const createError = (message: string, info = {}) => {
      // FIXME: Create ApiError custom error
      const error = new Error(message) as any
      error.info = info
      return error
    }
    const url = `/_api${path}`
    const { data } = await axios({ method, url, ...payload }).catch(function () {
      throw createError('Error')
    })
    const { ok, error, info } = data
    if (ok) {
      return data
    }
    throw createError(error, info)
  }

  static escape = (html: string, encode = false) =>
    html
      .replace(!encode ? /&(?!#?\w+;)/g : /&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  static unescape = (html: string) =>
    html.replace(/&([#\w]+);/g, (_, n) => {
      n = n.toLowerCase()
      if (n === 'colon') return ':'
      if (n.charAt(0) === '#') {
        return n.charAt(1) === 'x' ? String.fromCharCode(parseInt(n.substring(2), 16)) : String.fromCharCode(+n.substring(1))
      }
      return ''
    })
}
