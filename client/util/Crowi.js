/**
 * Crowi context class for client
 */

import axios from 'axios'
import io from 'socket.io-client'

export default class Crowi {
  constructor(context, window) {
    this.context = context
    this.config = {}
    this.csrfToken = context.csrfToken
    this.setUser(context.user)

    this.window = window
    this.location = window.location || {}
    this.document = window.document || {}
    this.localStorage = window.localStorage || {}

    this.fetchUsers = this.fetchUsers.bind(this)
    this.fetchTeams = this.fetchTeams.bind(this)
    this.apiGet = this.apiGet.bind(this)
    this.apiPost = this.apiPost.bind(this)
    this.apiRequest = this.apiRequest.bind(this)

    this.users = []
    this.userByName = {}
    this.userById = {}

    this.teams = []
    this.teamByHandle = {}
    this.teamById = {}

    this.draft = {}

    this.recoverData()

    this.socket = io({
      transports: ['websocket'],
    })
  }

  getContext() {
    return this.context
  }

  setConfig(config) {
    this.config = config
  }

  getConfig() {
    return this.config
  }

  setUser(user) {
    const { id = '', name = '' } = user || {}
    this.user = { id, name }
  }

  getUser() {
    return this.user
  }

  getWebSocket() {
    return this.socket
  }

  recoverData() {
    const keys = ['userByName', 'userById', 'users', 'draft', 'teams', 'teamByHandle', 'teamById']

    keys.forEach(key => {
      if (this.localStorage[key]) {
        try {
          this[key] = JSON.parse(this.localStorage[key])
        } catch (e) {
          this.localStorage.removeItem(key)
        }
      }
    })
  }

  fetchUsers() {
    const interval = 1000 * 60 * 15 // 15min
    const currentTime = new Date()
    if (this.localStorage.lastUserFetched && interval > currentTime - new Date(this.localStorage.lastUserFetched)) {
      return
    }

    this.apiGet('/users.list', {})
      .then(data => {
        this.users = data.users
        this.localStorage.users = JSON.stringify(data.users)

        let userByName = {}
        let userById = {}
        for (let i = 0; i < data.users.length; i++) {
          const user = data.users[i]
          userByName[user.username] = user
          userById[user._id] = user
        }
        this.userByName = userByName
        this.localStorage.userByName = JSON.stringify(userByName)

        this.userById = userById
        this.localStorage.userById = JSON.stringify(userById)

        this.localStorage.lastUserFetched = new Date()
      })
      .catch(err => {
        this.localStorage.removeItem('lastUserFetched')
        // ignore errors
      })
  }

  fetchTeams() {
    const interval = 1000 * 60 * 15 // 15min
    const currentTime = new Date()
    if (this.localStorage.lastTeamFetched && interval > currentTime - new Date(this.localStorage.lastTeamFetched)) {
      return
    }

    this.apiGet('/teams.list', {})
      .then(data => {
        const { teams } = data

        const teamByHandle = {}
        const teamById = {}
        teams.forEach(team => {
          teamByHandle[team.handle] = team
          teamById[team._id] = team
        })

        // Freeze objects to prevent changes by util user.
        // When cache expired, these objects will not be reused. I think there is no problem.
        Object.freeze(teams)
        Object.freeze(teamByHandle)
        Object.freeze(teamById)

        // save
        this.teams = teams
        this.teamByHandle = teamByHandle
        this.teamById = teamById

        this.localStorage.teams = JSON.stringify(teams)
        this.localStorage.teamByHandle = JSON.stringify(teamByHandle)
        this.localStorage.teamById = JSON.stringify(teamById)
        this.localStorage.lastTeamFetched = new Date()
      })
      .catch(err => {
        this.localStorage.removeItem('lastTeamFetched')
        // ignore errors
      })
  }

  clearDraft(path) {
    delete this.draft[path]
    this.localStorage.draft = JSON.stringify(this.draft)
  }

  saveDraft(path, body) {
    this.draft[path] = body
    this.localStorage.draft = JSON.stringify(this.draft)
  }

  findDraft(path) {
    if (this.draft && this.draft[path]) {
      return this.draft[path]
    }

    return null
  }

  findUserById(userId) {
    if (this.userById && this.userById[userId]) {
      return this.userById[userId]
    }

    return null
  }

  findUserByIds(userIds) {
    let users = []
    for (let userId of userIds) {
      let user = this.findUserById(userId)
      if (user) {
        users.push(user)
      }
    }

    return users
  }

  findUser(username) {
    if (this.userByName && this.userByName[username]) {
      return this.userByName[username]
    }

    return null
  }

  async apiGet(path, params = {}) {
    return this.apiRequest('get', path, { params })
  }

  async apiPost(path, params = {}) {
    if (!params._csrf) {
      params._csrf = this.csrfToken
    }

    return this.apiRequest('post', path, params)
  }

  async apiRequest(method, path, params) {
    const createError = (message, info = {}) => {
      let error = new Error(message)
      error.info = info
      return error
    }
    const { data } = await axios[method](`/_api${path}`, params).catch(function() {
      throw createError('Error')
    })
    const { ok, error, info } = data
    if (ok) {
      return data
    }
    throw createError(error, info)
  }

  static escape(html, encode) {
    return html
      .replace(!encode ? /&(?!#?\w+;)/g : /&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  static unescape(html) {
    return html.replace(/&([#\w]+);/g, function(_, n) {
      n = n.toLowerCase()
      if (n === 'colon') return ':'
      if (n.charAt(0) === '#') {
        return n.charAt(1) === 'x' ? String.fromCharCode(parseInt(n.substring(2), 16)) : String.fromCharCode(+n.substring(1))
      }
      return ''
    })
  }
}
