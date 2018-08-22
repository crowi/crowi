module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:page')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const GRANT_PUBLIC = 1
  const GRANT_RESTRICTED = 2
  const GRANT_SPECIFIED = 3
  const GRANT_OWNER = 4
  const PAGE_GRANT_ERROR = 1
  const STATUS_WIP = 'wip'
  const STATUS_PUBLISHED = 'published'
  const STATUS_DELETED = 'deleted'
  const STATUS_DEPRECATED = 'deprecated'
  const TYPE_PORTAL = 'portal'
  const TYPE_USER = 'user'
  const TYPE_PUBLIC = 'public'
  const pageEvent = crowi.event('page')

  function isPortalPath(path) {
    return path.endsWith('/')
  }

  function addTrailingSlash(path) {
    return path.endsWith('/') ? path : `${path}/`
  }

  function removeTrailingSlash(string) {
    return string.endsWith('/') ? string.substring(0, string.length - 1) : string
  }

  const pageSchema = new mongoose.Schema(
    {
      path: { type: String, required: true, index: true, unique: true },
      revision: { type: ObjectId, ref: 'Revision' },
      redirectTo: { type: String, index: true },
      status: { type: String, default: STATUS_PUBLISHED, index: true },
      grant: { type: Number, default: GRANT_PUBLIC, index: true },
      grantedUsers: [{ type: ObjectId, ref: 'User' }],
      creator: { type: ObjectId, ref: 'User', index: true },
      // lastUpdateUser: this schema is from 1.5.x (by deletion feature), and null is default.
      // the last update user on the screen is by revesion.author for B.C.
      lastUpdateUser: { type: ObjectId, ref: 'User', index: true },
      liker: [{ type: ObjectId, ref: 'User', index: true }],
      seenUsers: [{ type: ObjectId, ref: 'User', index: true }],
      commentCount: { type: Number, default: 0 },
      extended: {
        type: String,
        default: '{}',
        get: function(data) {
          try {
            return JSON.parse(data)
          } catch (e) {
            return data
          }
        },
        set: function(data) {
          return JSON.stringify(data)
        },
      },
      createdAt: { type: Date, default: Date.now },
      updatedAt: Date,
    },
    {
      toJSON: { getters: true },
      toObject: { getters: true },
    },
  )

  pageEvent.on('create', pageEvent.onCreate)
  pageEvent.on('update', pageEvent.onUpdate)

  pageSchema.methods.isWIP = function() {
    return this.status === STATUS_WIP
  }

  pageSchema.methods.isPublished = function() {
    // null: this is for B.C.
    return this.status === null || this.status === STATUS_PUBLISHED
  }

  pageSchema.methods.isDeleted = function() {
    return this.status === STATUS_DELETED
  }

  pageSchema.methods.isDeprecated = function() {
    return this.status === STATUS_DEPRECATED
  }

  pageSchema.methods.isPublic = function() {
    if (!this.grant || this.grant == GRANT_PUBLIC) {
      return true
    }

    return false
  }

  pageSchema.methods.isPortal = function() {
    return isPortalPath(this.path)
  }

  pageSchema.methods.isCreator = function(userData) {
    if (this.populated('creator') && this.creator._id.toString() === userData._id.toString()) {
      return true
    } else if (this.creator.toString() === userData._id.toString()) {
      return true
    }

    return false
  }

  pageSchema.methods.isGrantedFor = function(userData) {
    if (this.isPublic() || this.isCreator(userData)) {
      return true
    }

    if (this.grantedUsers.indexOf(userData._id) >= 0) {
      return true
    }

    return false
  }

  pageSchema.methods.isLatestRevision = function() {
    // populate されていなくて判断できない
    if (!this.latestRevision || !this.revision) {
      return true
    }

    return this.latestRevision == this.revision._id.toString()
  }

  pageSchema.methods.isUpdatable = function(previousRevision) {
    var revision = this.latestRevision || this.revision
    if (revision != previousRevision) {
      return false
    }
    return true
  }

  pageSchema.methods.isLiked = function(userData) {
    return this.liker.some(function(likedUser) {
      return likedUser == userData._id.toString()
    })
  }

  pageSchema.methods.isRedirectOriginPage = function() {
    return this.redirectTo !== null
  }

  pageSchema.methods.isUnlinkable = function(userData) {
    return this.isRedirectOriginPage() && this.isGrantedFor(userData)
  }

  pageSchema.methods.like = function(userData) {
    var self = this

    return new Promise(function(resolve, reject) {
      var added = self.liker.addToSet(userData._id)
      if (added.length > 0) {
        self.save(function(err, data) {
          if (err) {
            return reject(err)
          }
          debug('liker updated!', added)
          return resolve(data)
        })
      } else {
        debug('liker not updated')
        return reject(self)
      }
    })
  }

  pageSchema.methods.unlike = function(userData, callback) {
    var self = this

    return new Promise(function(resolve, reject) {
      var beforeCount = self.liker.length
      self.liker.pull(userData._id)
      if (self.liker.length != beforeCount) {
        self.save(function(err, data) {
          if (err) {
            return reject(err)
          }
          return resolve(data)
        })
      } else {
        debug('liker not updated')
        return reject(self)
      }
    })
  }

  // Unlink: Remove redirect origin page
  pageSchema.methods.unlink = async function(userData) {
    const Page = crowi.model('Page')
    if (this.isUnlinkable(userData)) {
      debug('Unlink page', this._id, this.path)
      try {
        const redirectPage = await Page.removePageById(this._id)
        debug('Redirect Page deleted', redirectPage.path)
      } catch (err) {
        debug('Error occured while get setting', err, err.stack)
        throw new Error(`Failed to delete redirect page (${this.path}).`)
      }
    } else {
      throw new Error('Page is not unlinkable')
    }
  }

  pageSchema.methods.isSeenUser = function(userData) {
    return this.seenUsers.some(function(seenUser) {
      return seenUser.equals(userData._id)
    })
  }

  pageSchema.methods.seen = function(userData) {
    var self = this

    if (this.isSeenUser(userData)) {
      debug('seenUsers not updated')
      return Promise.resolve(this)
    }

    return new Promise(function(resolve, reject) {
      if (!userData || !userData._id) {
        reject(new Error('User data is not valid'))
      }

      var added = self.seenUsers.addToSet(userData)
      self.save(function(err, data) {
        if (err) {
          return reject(err)
        }

        debug('seenUsers updated!', added)
        return resolve(self)
      })
    })
  }

  pageSchema.methods.getSlackChannel = function() {
    var extended = this.get('extended')
    if (!extended) {
      return ''
    }

    return extended.slack || ''
  }

  pageSchema.methods.updateSlackChannel = function(slackChannel) {
    var extended = this.extended
    extended.slack = slackChannel

    return this.updateExtended(extended)
  }

  pageSchema.methods.updateExtended = function(extended) {
    var page = this
    page.extended = extended
    return new Promise(function(resolve, reject) {
      return page.save(function(err, doc) {
        if (err) {
          return reject(err)
        }
        return resolve(doc)
      })
    })
  }

  pageSchema.statics.populatePageData = function(pageData, revisionId) {
    var Page = crowi.model('Page')
    var User = crowi.model('User')

    pageData.latestRevision = pageData.revision
    if (revisionId) {
      pageData.revision = revisionId
    }
    pageData.likerCount = pageData.liker.length || 0
    pageData.seenUsersCount = pageData.seenUsers.length || 0

    return new Promise(function(resolve, reject) {
      pageData.populate(
        [
          { path: 'lastUpdateUser', model: 'User', select: User.USER_PUBLIC_FIELDS },
          { path: 'creator', model: 'User', select: User.USER_PUBLIC_FIELDS },
          { path: 'revision', model: 'Revision' },
          // {path: 'liker', options: { limit: 11 }},
          // {path: 'seenUsers', options: { limit: 11 }},
        ],
        function(err, pageData) {
          Page.populate(pageData, { path: 'revision.author', model: 'User', select: User.USER_PUBLIC_FIELDS }, function(
            err,
            data,
          ) {
            if (err) {
              return reject(err)
            }

            return resolve(data)
          })
        },
      )
    })
  }

  pageSchema.statics.populatePageListToAnyObjects = function(pageIdObjectArray) {
    var Page = this
    var pageIdMappings = {}
    var pageIds = pageIdObjectArray.map(function(page, idx) {
      if (!page._id) {
        throw new Error('Pass the arg of populatePageListToAnyObjects() must have _id on each element.')
      }

      pageIdMappings[String(page._id)] = idx
      return page._id
    })

    return new Promise(function(resolve, reject) {
      Page.findListByPageIds(pageIds, { limit: 100 }) // limit => if the pagIds is greater than 100, ignore
        .then(function(pages) {
          pages.forEach(function(page) {
            Object.assign(pageIdObjectArray[pageIdMappings[String(page._id)]], page._doc)
          })

          resolve(pageIdObjectArray)
        })
    })
  }

  pageSchema.statics.updateCommentCount = function(page, num) {
    var self = this

    return new Promise(function(resolve, reject) {
      self.update({ _id: page }, { commentCount: num }, {}, function(err, data) {
        if (err) {
          debug('Update commentCount Error', err)
          return reject(err)
        }

        return resolve(data)
      })
    })
  }

  pageSchema.statics.hasPortalPage = function(path, user, revisionId) {
    var self = this
    return new Promise(function(resolve, reject) {
      self
        .findPage(path, user, revisionId)
        .then(function(page) {
          resolve(page)
        })
        .catch(function(err) {
          resolve(null) // check only has portal page, through error
        })
    })
  }

  pageSchema.statics.getGrantLabels = function() {
    var grantLabels = {}
    grantLabels[GRANT_PUBLIC] = 'Public' // 公開
    grantLabels[GRANT_RESTRICTED] = 'Anyone with the link' // リンクを知っている人のみ
    // grantLabels[GRANT_SPECIFIED]  = 'Specified users only'; // 特定ユーザーのみ
    grantLabels[GRANT_OWNER] = 'Just me' // 自分のみ

    return grantLabels
  }

  pageSchema.statics.normalizePath = function(path) {
    if (!path.match(/^\//)) {
      path = '/' + path
    }

    path = path.replace(/\/\s+?/g, '/').replace(/\s+\//g, '/')

    return path
  }

  pageSchema.statics.getUserPagePath = function(user) {
    return '/user/' + user.username
  }

  pageSchema.statics.getDeletedPageName = function(path) {
    if (path.match('/')) {
      path = path.substr(1)
    }
    return '/trash/' + path
  }

  pageSchema.statics.getRevertDeletedPageName = function(path) {
    return path.replace('/trash', '')
  }

  pageSchema.statics.isDeletableName = function(path) {
    var notDeletable = [
      /^\/user\/[^/]+$/, // user page
    ]

    for (var i = 0; i < notDeletable.length; i++) {
      var pattern = notDeletable[i]
      if (path.match(pattern)) {
        return false
      }
    }

    return true
  }

  pageSchema.statics.isCreatableName = function(name) {
    var forbiddenPages = [
      /\^|\$|\*|\+|#/,
      /^\/_.*/, // /_api/* and so on
      /^\/-\/.*/,
      /^\/_r\/.*/,
      /^\/user\/[^/]+\/(bookmarks|comments|activities|pages|recent-create|recent-edit)/, // reserved
      /^\/?https?:\/\/.+$/, // avoid miss in renaming
      /\/{2,}/, // avoid miss in renaming
      /\s+\/\s+/, // avoid miss in renaming
      /.+\/edit$/,
      /.+\.md$/,
      /^\/(installer|register|login|logout|admin|me|files|trash|paste|comments)(\/.*|$)/,
    ]

    var isCreatable = true
    forbiddenPages.forEach(function(page) {
      var pageNameReg = new RegExp(page)
      if (name.match(pageNameReg)) {
        isCreatable = false
      }
    })

    return isCreatable
  }

  pageSchema.statics.fixToCreatableName = function(path) {
    return path.replace(/\/\//g, '/')
  }

  pageSchema.statics.updateRevision = function(pageId, revisionId, cb) {
    this.update({ _id: pageId }, { revision: revisionId }, {}, function(err, data) {
      cb(err, data)
    })
  }

  pageSchema.statics.exists = async function(query) {
    const self = this
    const count = await self.count(query)
    return count > 0
  }

  pageSchema.statics.findUpdatedList = function(offset, limit, cb) {
    this.find({})
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .exec(function(err, data) {
        cb(err, data)
      })
  }

  pageSchema.statics.findPageById = function(id) {
    var Page = this

    return new Promise(function(resolve, reject) {
      Page.findOne({ _id: id }, function(err, pageData) {
        if (err) {
          return reject(err)
        }

        if (pageData == null) {
          return reject(new Error('Page not found'))
        }
        return Page.populatePageData(pageData, null).then(resolve)
      })
    })
  }

  pageSchema.statics.findPageByIdAndGrantedUser = function(id, userData) {
    var Page = this

    return new Promise(function(resolve, reject) {
      Page.findPageById(id)
        .then(function(pageData) {
          if (userData && !pageData.isGrantedFor(userData)) {
            return reject(new Error('Page is not granted for the user')) // PAGE_GRANT_ERROR, null);
          }

          return resolve(pageData)
        })
        .catch(function(err) {
          return reject(err)
        })
    })
  }

  // find page and check if granted user
  pageSchema.statics.findPage = function(path, userData, revisionId, ignoreNotFound) {
    var self = this

    return new Promise(function(resolve, reject) {
      self.findOne({ path: path }, function(err, pageData) {
        if (err) {
          return reject(err)
        }

        if (pageData === null) {
          if (ignoreNotFound) {
            return resolve(null)
          }

          var pageNotFoundError = new Error('Page Not Found')
          pageNotFoundError.name = 'Crowi:Page:NotFound'
          return reject(pageNotFoundError)
        }

        if (!pageData.isGrantedFor(userData)) {
          return reject(new Error('Page is not granted for the user')) // PAGE_GRANT_ERROR, null);
        }

        self
          .populatePageData(pageData, revisionId || null)
          .then(resolve)
          .catch(reject)
      })
    })
  }

  // find page by path
  pageSchema.statics.findPageByPath = function(path) {
    var Page = this

    return new Promise(function(resolve, reject) {
      Page.findOne({ path: path }, function(err, pageData) {
        if (err || pageData === null) {
          return reject(err)
        }

        return resolve(pageData)
      })
    })
  }

  pageSchema.statics.findListByPageIds = function(ids, options) {
    var Page = this
    var User = crowi.model('User')
    var options = options || {}
    var limit = options.limit || 50
    var offset = options.skip || 0

    return new Promise(function(resolve, reject) {
      Page.find({ _id: { $in: ids }, grant: GRANT_PUBLIC })
        // .sort({createdAt: -1}) // TODO optionize
        .skip(offset)
        .limit(limit)
        .populate([
          { path: 'creator', model: 'User', select: User.USER_PUBLIC_FIELDS },
          { path: 'revision', model: 'Revision' },
        ])
        .exec(function(err, pages) {
          if (err) {
            return reject(err)
          }

          Page.populate(pages, { path: 'revision.author', model: 'User', select: User.USER_PUBLIC_FIELDS }, function(
            err,
            data,
          ) {
            if (err) {
              return reject(err)
            }

            return resolve(data)
          })
        })
    })
  }

  pageSchema.statics.findPageByRedirectTo = function(path) {
    var Page = this

    return new Promise(function(resolve, reject) {
      Page.findOne({ redirectTo: path }, function(err, pageData) {
        if (err || pageData === null) {
          return reject(err)
        }

        return resolve(pageData)
      })
    })
  }

  pageSchema.statics.findListByCreator = function(user, option, currentUser) {
    var Page = this
    var User = crowi.model('User')
    var limit = option.limit || 50
    var offset = option.offset || 0
    var conditions = {
      creator: user._id,
      redirectTo: null,
      $or: [{ status: null }, { status: STATUS_PUBLISHED }],
    }

    if (!user.equals(currentUser._id)) {
      conditions.grant = GRANT_PUBLIC
    }

    return new Promise(function(resolve, reject) {
      Page.find(conditions)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate('revision')
        .exec()
        .then(function(pages) {
          return Page.populate(pages, { path: 'revision.author', model: 'User', select: User.USER_PUBLIC_FIELDS }).then(
            resolve,
          )
        })
    })
  }

  /**
   * Bulk get (for internal only)
   */
  pageSchema.statics.getStreamOfFindAll = function(options) {
    var options = options || {}
    var publicOnly = options.publicOnly || true
    var criteria = { redirectTo: null }

    if (publicOnly) {
      criteria.grant = GRANT_PUBLIC
    }

    return this.find(criteria)
      .populate([{ path: 'creator', model: 'User' }, { path: 'revision', model: 'Revision' }])
      .sort({ updatedAt: -1 })
      .cursor()
  }

  /**
   * findListByStartWith
   *
   * If `path` has `/` at the end, returns '{path}/*' and '{path}' self.
   * If `path` doesn't have `/` at the end, returns '{path}*'
   * e.g.
   */
  pageSchema.statics.findListByStartWith = function(path, userData, option) {
    var Page = this
    var User = crowi.model('User')
    var pathCondition = []
    var includeDeletedPage = option.includeDeletedPage || false

    if (!option) {
      option = { sort: 'updatedAt', desc: -1, offset: 0, limit: 50 }
    }
    var opt = {
      sort: option.sort || 'updatedAt',
      desc: option.desc || -1,
      offset: option.offset || 0,
      limit: option.limit === 0 ? 0 : option.limit || 50,
    }
    var sortOpt = {}
    sortOpt[opt.sort] = opt.desc
    var queryReg = new RegExp('^' + path)
    // var sliceOption = option.revisionSlice || { $slice: 1 }

    pathCondition.push({ path: queryReg })
    if (path.match(/\/$/)) {
      debug('Page list by ending with /, so find also upper level page')
      pathCondition.push({ path: path.substr(0, path.length - 1) })
    }

    return new Promise(function(resolve, reject) {
      // FIXME: might be heavy
      var q = Page.find({
        redirectTo: null,
        $or: [
          { grant: null },
          { grant: GRANT_PUBLIC },
          { grant: GRANT_RESTRICTED, grantedUsers: userData._id },
          { grant: GRANT_SPECIFIED, grantedUsers: userData._id },
          { grant: GRANT_OWNER, grantedUsers: userData._id },
        ],
      })
        .populate('revision')
        .and({
          $or: pathCondition,
        })
        .sort(sortOpt)
        .skip(opt.offset)
        .limit(opt.limit)

      if (!includeDeletedPage) {
        q.and({
          $or: [{ status: null }, { status: STATUS_PUBLISHED }],
        })
      }

      q.exec().then(function(pages) {
        Page.populate(pages, { path: 'revision.author', model: 'User', select: User.USER_PUBLIC_FIELDS })
          .then(resolve)
          .catch(reject)
      })
    })
  }

  pageSchema.statics.findChildrenByPath = async function(path, userData, option) {
    path = addTrailingSlash(path)
    return this.findListByStartWith(path, userData, { limit: 0, ...option })
  }

  pageSchema.statics.updatePageProperty = function(page, updateData) {
    var Page = this
    return new Promise(function(resolve, reject) {
      // TODO foreach して save
      Page.update({ _id: page._id }, { $set: updateData }, function(err, data) {
        if (err) {
          return reject(err)
        }

        return resolve(data)
      })
    })
  }

  pageSchema.statics.updateGrant = function(page, grant, userData) {
    return new Promise(function(resolve, reject) {
      page.grant = grant
      if (grant == GRANT_PUBLIC) {
        page.grantedUsers = []
      } else {
        page.grantedUsers = []
        page.grantedUsers.addToSet(userData._id)
      }

      page.save(function(err, data) {
        debug('Page.updateGrant, saved grantedUsers.', err, (data && data.path) || {})
        if (err) {
          return reject(err)
        }

        return resolve(data)
      })
    })
  }

  // Instance method でいいのでは
  pageSchema.statics.pushToGrantedUsers = function(page, userData) {
    return new Promise(function(resolve, reject) {
      if (!page.grantedUsers || !Array.isArray(page.grantedUsers)) {
        page.grantedUsers = []
      }
      page.grantedUsers.addToSet(userData)
      page.save(function(err, data) {
        if (err) {
          return reject(err)
        }
        return resolve(data)
      })
    })
  }

  pageSchema.statics.pushRevision = function(pageData, newRevision, user) {
    var isCreate = false
    if (pageData.revision === undefined) {
      debug('pushRevision on Create')
      isCreate = true
    }

    return new Promise(function(resolve, reject) {
      newRevision.save(function(err, newRevision) {
        if (err) {
          debug('Error on saving revision', err)
          return reject(err)
        }

        debug('Successfully saved new revision', newRevision)
        pageData.revision = newRevision
        pageData.lastUpdateUser = user
        pageData.updatedAt = Date.now()
        pageData.save(function(err, data) {
          if (err) {
            // todo: remove new revision?
            debug('Error on save page data (after push revision)', err)
            return reject(err)
          }

          resolve(data)
          if (!isCreate) {
            debug('pushRevision on Update')
          }
        })
      })
    })
  }

  pageSchema.statics.create = function(path, body, user, options) {
    var Page = this
    var Revision = crowi.model('Revision')
    var format = options.format || 'markdown'
    var grant = options.grant || GRANT_PUBLIC
    var redirectTo = options.redirectTo || null

    // force public
    if (isPortalPath(path)) {
      grant = GRANT_PUBLIC
    }

    return new Promise(function(resolve, reject) {
      Page.findOne({ path: path }, function(err, pageData) {
        if (pageData) {
          return reject(new Error('Cannot create new page to existed path'))
        }

        var newPage = new Page()
        newPage.path = path
        newPage.creator = user
        newPage.lastUpdateUser = user
        newPage.createdAt = Date.now()
        newPage.updatedAt = Date.now()
        newPage.redirectTo = redirectTo
        newPage.grant = grant
        newPage.status = STATUS_PUBLISHED
        newPage.grantedUsers = []
        newPage.grantedUsers.push(user)

        newPage.save(function(err, newPage) {
          if (err) {
            return reject(err)
          }

          var newRevision = Revision.prepareRevision(newPage, body, user, { format: format })
          Page.pushRevision(newPage, newRevision, user)
            .then(function(data) {
              resolve(data)
              pageEvent.emit('create', data, user)
            })
            .catch(function(err) {
              debug('Push Revision Error on create page', err)
              return reject(err)
            })
        })
      })
    })
  }

  pageSchema.statics.updatePage = function(pageData, body, user, options = {}) {
    const Page = this
    const Revision = crowi.model('Revision')
    const Bookmark = crowi.model('Bookmark')
    const grant = options.grant || null
    // update existing page
    const newRevision = Revision.prepareRevision(pageData, body, user)

    return new Promise(async (resolve, reject) => {
      Page.pushRevision(pageData, newRevision, user)
        .then(async revision => {
          const bookmarkCount = await Bookmark.countByPageId(pageData._id)

          if (grant != pageData.grant) {
            return Page.updateGrant(pageData, grant, user).then(function(data) {
              resolve(data)
              pageEvent.emit('update', data, user, bookmarkCount)
            })
          } else {
            resolve(pageData)
            pageEvent.emit('update', pageData, user, bookmarkCount)
          }
        })
        .catch(function(err) {
          debug('Error on update', err)
          debug('Error on update', err.stack)
        })
    })
  }

  pageSchema.statics.deletePage = function(pageData, user, options) {
    var Page = this
    var Share = crowi.model('Share')
    var newPath = Page.getDeletedPageName(pageData.path)
    if (Page.isDeletableName(pageData.path)) {
      return new Promise(function(resolve, reject) {
        Page.updatePageProperty(pageData, { status: STATUS_DELETED, lastUpdateUser: user })
          .then(function() {
            return Share.deleteByPageId(pageData._id)
          })
          .then(function(share) {
            pageData.status = STATUS_DELETED

            // ページ名が /trash/ 以下に存在する場合、おかしなことになる
            // が、 /trash 以下にページが有るのは、個別に作っていたケースのみ。
            // 一応しばらく前から uncreatable pages になっているのでこれでいいことにする
            debug('Deleted the page, and rename it', pageData.path, newPath)
            return Page.rename(pageData, newPath, user, { createRedirectPage: true })
          })
          .then(function(pageData) {
            resolve(pageData)
          })
          .catch(reject)
      })
    } else {
      return Promise.reject(new Error('Page is not deletable.'))
    }
  }

  pageSchema.statics.revertDeletedPage = function(pageData, user, options) {
    var Page = this
    var newPath = Page.getRevertDeletedPageName(pageData.path)

    // 削除時、元ページの path には必ず redirectTo 付きで、ページが作成される。
    // そのため、そいつは削除してOK
    // が、redirectTo ではないページが存在している場合それは何かがおかしい。(データ補正が必要)
    return new Promise(function(resolve, reject) {
      Page.findPageByPath(newPath)
        .then(function(originPageData) {
          if (originPageData.redirectTo !== pageData.path) {
            throw new Error(
              'The new page of to revert is exists and the redirect path of the page is not the deleted page.',
            )
          }

          return Page.completelyDeletePage(originPageData)
        })
        .then(function(done) {
          return Page.updatePageProperty(pageData, { status: STATUS_PUBLISHED, lastUpdateUser: user })
        })
        .then(function(done) {
          pageData.status = STATUS_PUBLISHED

          debug('Revert deleted the page, and rename again it', pageData, newPath)
          return Page.rename(pageData, newPath, user, {})
        })
        .then(function(done) {
          pageData.path = newPath
          resolve(pageData)
        })
        .catch(reject)
    })
  }

  /**
   * This is danger.
   */
  pageSchema.statics.completelyDeletePage = function(pageData, user, options) {
    // Delete Bookmarks, Attachments, Revisions, Pages and emit delete
    var Bookmark = crowi.model('Bookmark')
    var Attachment = crowi.model('Attachment')
    var Comment = crowi.model('Comment')
    var Page = this
    var pageId = pageData._id

    debug('Completely delete', pageData.path)

    return new Promise(function(resolve, reject) {
      Bookmark.removeBookmarksByPageId(pageId)
        .then(function(done) {
          return Attachment.removeAttachmentsByPageId(pageId)
        })
        .then(function(done) {
          return Comment.removeCommentsByPageId(pageId)
        })
        .then(function(done) {
          return Page.removePageById(pageId)
        })
        .then(function(done) {
          return Page.removeRedirectOriginPageByPath(pageData.path)
        })
        .then(function(done) {
          pageEvent.emit('delete', pageData, user) // update as renamed page
          resolve(pageData)
        })
        .catch(reject)
    })
  }

  pageSchema.statics.removePage = async function(pageData) {
    const Page = this
    const Revision = crowi.model('Revision')
    const { _id } = pageData

    debug('Remove phisically, the page', _id)
    try {
      await Page.remove({ _id })
    } catch (err) {
      debug(' --> error', _id)
      throw err
    }
    await Revision.removeRevisionsByPath(pageData.path)
    return pageData
  }

  pageSchema.statics.removePageById = async function(pageId) {
    const Page = this
    const pageData = await Page.findPageById(pageId)
    await Page.removePage(pageData)
    return pageData
  }

  pageSchema.statics.removePageByPath = async function(pagePath) {
    const Page = this
    const pageData = await Page.findPageByPath(pagePath)
    await Page.removePage(pageData)
    return pageData
  }

  /**
   * remove the page that is redirecting to specified `pagePath` recursively
   *  ex: when
   *    '/page1' redirects to '/page2' and
   *    '/page2' redirects to '/page3'
   *    and given '/page3',
   *    '/page1' and '/page2' will be removed
   *
   * @param {string} pagePath
   */
  pageSchema.statics.removeRedirectOriginPageByPath = function(pagePath) {
    var Page = this

    return Page.findPageByRedirectTo(pagePath)
      .then(redirectOriginPageData => {
        // remove
        return (
          Page.removePageById(redirectOriginPageData.id)
            // remove recursive
            .then(() => {
              return Page.removeRedirectOriginPageByPath(redirectOriginPageData.path)
            })
        )
      })
      .catch(err => {
        // do nothing if origin page doesn't exist
        return Promise.resolve()
      })
  }

  pageSchema.statics.rename = function(pageData, newPagePath, user, options) {
    var Page = this
    var Revision = crowi.model('Revision')
    var path = pageData.path
    var createRedirectPage = options.createRedirectPage || 0
    // var moveUnderTrees = options.moveUnderTrees || 0

    return new Promise(function(resolve, reject) {
      // pageData の path を変更
      Page.updatePageProperty(pageData, { updatedAt: Date.now(), path: newPagePath, lastUpdateUser: user })
        .then(function(data) {
          // reivisions の path を変更
          return Revision.updateRevisionListByPath(path, { path: newPagePath }, {})
        })
        .then(function(data) {
          pageData.path = newPagePath

          if (createRedirectPage) {
            var body = 'redirect ' + newPagePath
            Page.create(path, body, user, { redirectTo: newPagePath })
              .then(resolve)
              .catch(reject)
          } else {
            resolve(data)
          }
          pageEvent.emit('update', pageData, user) // update as renamed page
        })
    })
  }

  pageSchema.statics.getPathMap = function(paths, search, replace) {
    search = removeTrailingSlash(search)
    replace = this.normalizePath(replace)
    const renamePath = path => path.replace(search, replace)
    // { [oldPath]: newPath }
    return paths.map(({ path }) => [path, renamePath(path)]).reduce((l, [k, v]) => Object.assign(l, { [k]: v }), {})
  }

  pageSchema.statics.checkPagesRenamable = async function(paths, user) {
    const Page = this
    let error = false
    let errors = {}
    for (let path of paths) {
      let e = []
      if (!Page.isCreatableName(path)) {
        e.push('rename_tree.error.can_not_use_this_name')
      }
      const isAlreadyExists = await Page.exists({ path })
      if (isAlreadyExists) {
        const newPage = await Page.findPageByPath(path)
        if (!newPage.isUnlinkable(user)) {
          e.push('rename_tree.error.already_exists')
        }
      }
      if (!error && e.length > 0) {
        error = true
      }
      errors = Object.assign(errors, { [path]: e })
    }
    return [error, errors]
  }

  pageSchema.statics.renameTree = async function(pathMap, user, options) {
    const Page = this
    const { createRedirectPage = false } = options
    await Promise.all(
      Object.values(pathMap).map(async newPath => {
        if (await Page.exists({ path: newPath })) {
          const newPage = await Page.findPageByPath(newPath)
          if (newPage.isUnlinkable(user)) {
            await newPage.unlink(user)
          } else {
            throw new Error(`Failed to create this page (${newPage.path}). It already exists.`)
          }
        }
      }),
    )
    return Promise.all(
      Object.entries(pathMap).map(async ([oldPath, newPath]) => {
        try {
          const options = { createRedirectPage: !isPortalPath(newPath) && createRedirectPage }
          const oldPage = await Page.findPageByPath(oldPath)
          await Page.rename(oldPage, newPath, user, options)
          return oldPage
        } catch (err) {
          throw new Error(`Failed to update page (${oldPath}).`)
        }
      }),
    )
  }

  pageSchema.statics.getHistories = function() {
    // TODO
  }

  pageSchema.statics.GRANT_PUBLIC = GRANT_PUBLIC
  pageSchema.statics.GRANT_RESTRICTED = GRANT_RESTRICTED
  pageSchema.statics.GRANT_SPECIFIED = GRANT_SPECIFIED
  pageSchema.statics.GRANT_OWNER = GRANT_OWNER
  pageSchema.statics.PAGE_GRANT_ERROR = PAGE_GRANT_ERROR
  pageSchema.statics.TYPE_PORTAL = TYPE_PORTAL
  pageSchema.statics.TYPE_PUBLIC = TYPE_PUBLIC
  pageSchema.statics.TYPE_USER = TYPE_USER

  return mongoose.model('Page', pageSchema)
}
