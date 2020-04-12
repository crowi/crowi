import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'
import { RevisionDocument } from './revision'
import { UserDocument } from './user'

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

export interface PageDocument extends Document {
  _id: Types.ObjectId
  path: string
  revision: Types.ObjectId
  redirectTo: string
  status: string
  grant: number
  grantedUsers: Types.ObjectId[]
  creator: Types.ObjectId
  lastUpdateUser: Types.ObjectId
  liker: Types.ObjectId[]
  seenUsers: Types.ObjectId[]
  commentCount: number
  extended: object
  createdAt: Date
  updatedAt: Date

  // dynamic fields
  latestRevision?: Types.ObjectId
  likerCount?: number
  seenUsersCount?: number

  isPublished(): boolean
  isDeleted(): boolean
  isDeprecated(): boolean
  isPublic(): boolean
  isPortal(): boolean
  isCreator(user: any): boolean
  isGrantedFor(user: any): boolean
  isLatestRevision(): boolean
  isUpdatable(previousRevision): boolean
  isLiked(user: any): boolean
  isRedirectOriginPage(): boolean
  isUnlinkable(user: any): boolean
  isWIP(): boolean
  like(user: any): any
  unlike(user: any): any
  unlink(user: any): any
  isSeenUser(user: any): any
  seen(user: any): any
  getSlackChannel(): any
  updateSlackChannel(slackChannel): any
  updateExtended(extended: object): any
  getNotificationTargetUsers(): any
}

export interface PageModel extends Model<PageDocument> {
  GRANT_PUBLIC: number
  GRANT_RESTRICTED: number
  GRANT_SPECIFIED: number
  GRANT_OWNER: number
  PAGE_GRANT_ERROR: number
  TYPE_PORTAL: string
  TYPE_PUBLIC: string
  TYPE_USER: string

  populatePageData(pageData, revisionId?: Types.ObjectId | null): Promise<PageDocument>
  populatePagesRevision(pages, revisions): any
  populatePageListToAnyObjects(pageIdObjectArray): any
  updateCommentCount(page, num): any
  hasPortalPage(path, user, revisionId?): Promise<boolean>
  findPortalPage(path, user, revisionId?): Promise<PageDocument | null>
  getGrantLabels(): any
  normalizePath(path): any
  getUserPagePath(user): any
  getDeletedPageName(path): any
  getRevertDeletedPageName(path): any
  isDeletableName(path): any
  isCreatableName(name): any
  fixToCreatableName(path): any
  updateRevision(pageId, revisionId, cb): any
  exists(query): any
  findUpdatedList(offset, limit, cb): any
  findPageById(id): Promise<PageDocument>
  findPageByIdAndGrantedUser(id, userData): Promise<PageDocument>
  findPage(path, userData, revisionId?, ignoreNotFound?): Promise<PageDocument | null>
  findPageByPath(path): Promise<PageDocument>
  isExistByPath(path): any
  isExistById(id): any
  findListByPageIds(ids, options): any
  findPageByRedirectTo(path): any
  findPagesByIds(ids): any
  findListByCreator(user, option, currentUser): any
  getStreamOfFindAll(options?): any
  findListByStartWith(path, userData, option): Promise<PageDocument[]>
  findChildrenByPath(path, userData, option): any
  findUnfurlablePages(type, array, grants?: number[]): any
  findUnfurlablePagesByIds(ids): any
  findUnfurlablePagesByPaths(paths): any
  updatePageProperty(page, updateData): any
  updateGrant(page, grant, userData): any
  pushToGrantedUsers(page, userData): any
  pushRevision(pageData, newRevision, user): any
  createPage(path, body, user, options): any
  updatePage(pageData: PageDocument, body, user, options: any): any
  deletePage(pageData: PageDocument, user): any
  revertDeletedPage(pageData: PageDocument, user): Promise<PageDocument>
  completelyDeletePage(pageData: PageDocument, user?): Promise<PageDocument>
  removePage(pageData: PageDocument): any
  removePageById(pageId): any
  removePageByPath(pagePath): any
  removeRedirectOriginPageByPath(pagePath): any
  rename(pageData, newPagePath, user, options): any
  getPathMap(paths, search, replace): any
  checkPagesRenamable(paths, user): any
  renameTree(pathMap, user, options): any
  allPageCount(): any
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:page')
  const pageEvent = crowi.event('Page')

  function isPortalPath(path) {
    return path.endsWith('/')
  }

  function addTrailingSlash(path) {
    return path.endsWith('/') ? path : `${path}/`
  }

  function removeTrailingSlash(string) {
    return string.endsWith('/') ? string.substring(0, string.length - 1) : string
  }

  const pageSchema = new Schema<PageDocument, PageModel>(
    {
      path: { type: String, required: true, index: true, unique: true },
      revision: { type: Schema.Types.ObjectId, ref: 'Revision' },
      redirectTo: { type: String, index: true },
      status: { type: String, default: STATUS_PUBLISHED, index: true },
      grant: { type: Number, default: GRANT_PUBLIC, index: true },
      grantedUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      creator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
      // lastUpdateUser: this schema is from 1.5.x (by deletion feature), and null is default.
      // the last update user on the screen is by revesion.author for B.C.
      lastUpdateUser: { type: Schema.Types.ObjectId, ref: 'User', index: true },
      liker: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
      seenUsers: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
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
    if (this.populated('creator') && ((this.creator as any) as UserDocument)._id.toString() === userData._id.toString()) {
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

    return this.latestRevision == (((this.revision as any) as RevisionDocument)._id.toString() as any)
  }

  pageSchema.methods.isUpdatable = function(previousRevision) {
    const revision = this.latestRevision || this.revision
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

  pageSchema.methods.like = async function(userData) {
    const Activity = crowi.model('Activity')

    const added = ((this.liker as any) as Types.Array<UserDocument>).addToSet(userData._id)
    if (added.length > 0) {
      const data = await this.save()

      debug('liker updated!', added)

      try {
        const activityLog = await Activity.createByPageLike(data, userData)
        debug('Activity created', activityLog)
      } catch (err) {
        debug('Activity err', err)
      }

      return data
    } else {
      debug('liker not updated')
    }
  }

  pageSchema.methods.unlike = async function(userData) {
    const Activity = crowi.model('Activity')

    const liker = (this.liker as any) as Types.Array<UserDocument>
    const beforeCount = liker.length
    liker.pull(userData._id)
    if (liker.length != beforeCount) {
      const data = await this.save()

      try {
        await Activity.removeByPageUnlike(data, userData)
        debug('Activity removed')
      } catch (err) {
        debug('Activity remove err', err)
      }

      return data
    } else {
      debug('liker not updated')
    }
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
    const seenUsers = (this.seenUsers as any) as UserDocument[]

    return seenUsers.some(function(seenUser) {
      return seenUser.equals(userData._id)
    })
  }

  pageSchema.methods.seen = async function(userData) {
    const seenUsers = (this.seenUsers as any) as Types.Array<UserDocument>

    if (this.isSeenUser(userData)) {
      debug('seenUsers not updated')
      return this
    }

    if (!userData || !userData._id) {
      throw new Error('User data is not valid')
    }

    const added = seenUsers.addToSet(userData)

    await this.save()

    debug('seenUsers updated!', added)

    return this
  }

  pageSchema.methods.getSlackChannel = function() {
    const extended = this.get('extended')
    if (!extended) {
      return ''
    }

    return extended.slack || ''
  }

  pageSchema.methods.updateSlackChannel = function(slackChannel) {
    const extended = this.extended as any
    extended.slack = slackChannel

    return this.updateExtended(extended)
  }

  pageSchema.methods.updateExtended = function(extended) {
    this.extended = extended
    return this.save()
  }

  pageSchema.statics.populatePageData = function(pageData: PageDocument, revisionId) {
    pageData.latestRevision = pageData.revision
    if (revisionId) {
      pageData.revision = revisionId
    }
    pageData.likerCount = pageData.liker.length || 0
    pageData.seenUsersCount = pageData.seenUsers.length || 0

    return pageData
      .populate([
        { path: 'lastUpdateUser', model: 'User' },
        { path: 'creator', model: 'User' },
        { path: 'revision', model: 'Revision', populate: { path: 'author', model: 'User' } },
      ])
      .execPopulate()
  }

  pageSchema.statics.populatePagesRevision = async function(pages, revisions) {
    if (pages.length !== revisions.length) {
      throw new TypeError('page.length must be equal revisions.length')
    }
    pages = pages.map((page, i) => {
      const revision = revisions[i]
      if (revision) {
        page.revision = revision
      }
      return page
    })
    return Page.populate(pages, { path: 'revision', model: 'Revision' })
  }

  pageSchema.statics.populatePageListToAnyObjects = async function(pageIdObjectArray) {
    const pageIdMappings = {}
    const pageIds = pageIdObjectArray.map(function(page, idx) {
      if (!page._id) {
        throw new Error('Pass the arg of populatePageListToAnyObjects() must have _id on each element.')
      }

      pageIdMappings[String(page._id)] = idx
      return page._id
    })

    const pages = await Page.findListByPageIds(pageIds, { limit: 100 }) // limit => if the pagIds is greater than 100, ignore

    for (const p of pages) {
      Object.assign(pageIdObjectArray[pageIdMappings[String(p._id)]], p._doc)
    }

    return pageIdObjectArray
  }

  pageSchema.statics.updateCommentCount = function(page, num) {
    return Page.updateOne({ _id: page }, { commentCount: num }, {})
  }

  pageSchema.statics.hasPortalPage = async function(path, user, revisionId) {
    try {
      const page = await Page.findPage(path, user, revisionId)
      return !!page
    } catch (err) {
      return false
    }
  }

  pageSchema.statics.findPortalPage = async function(path, user, revisionId) {
    try {
      const page = await Page.findPage(path, user, revisionId)
      return page
    } catch (err) {
      return null
    }
  }

  pageSchema.statics.getGrantLabels = function() {
    const grantLabels = {}
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
    const notDeletable = [
      /^\/user\/[^/]+$/, // user page
    ]

    for (let i = 0; i < notDeletable.length; i++) {
      const pattern = notDeletable[i]
      if (path.match(pattern)) {
        return false
      }
    }

    return true
  }

  pageSchema.statics.isCreatableName = function(name) {
    const forbiddenPages = [
      /\^|\$|\*|\+|\?|#/,
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

    let isCreatable = true
    forbiddenPages.forEach(function(page) {
      const pageNameReg = new RegExp(page)
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
    Page.updateOne({ _id: pageId }, { revision: revisionId }, {}, function(err, data) {
      cb(err, data)
    })
  }

  pageSchema.statics.exists = async function(query) {
    const count = await Page.countDocuments(query)
    return count > 0
  }

  pageSchema.statics.findUpdatedList = function(offset, limit, cb) {
    Page.find({})
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .exec()
  }

  pageSchema.statics.findPageById = async function(id) {
    const pageData = await Page.findOne({ _id: id })

    if (pageData === null) {
      throw new Error('Page not found')
    }

    return Page.populatePageData(pageData, null)
  }

  pageSchema.statics.findPageByIdAndGrantedUser = async function(id, userData) {
    const pageData = await Page.findPageById(id)

    if (userData && !pageData.isGrantedFor(userData)) {
      throw new Error('Page is not granted for the user') // PAGE_GRANT_ERROR, null);
    }

    return pageData
  }

  // find page and check if granted user
  pageSchema.statics.findPage = async function(path, userData, revisionId, ignoreNotFound) {
    const pageData = await Page.findOne({ path })

    if (pageData === null) {
      if (ignoreNotFound) {
        return null
      }

      const pageNotFoundError = new Error('Page Not Found')
      pageNotFoundError.name = 'Crowi:Page:NotFound'
      throw pageNotFoundError
    }

    if (!pageData.isGrantedFor(userData)) {
      throw new Error('Page is not granted for the user') // PAGE_GRANT_ERROR, null);
    }

    return Page.populatePageData(pageData, revisionId || null)
  }

  // find page by path
  pageSchema.statics.findPageByPath = async function(path) {
    const pageData = await Page.findOne({ path })
    if (pageData === null) {
      throw new Error('Page not found')
    }

    return pageData
  }

  pageSchema.statics.isExistByPath = async function(path) {
    const pageData = await Page.findOne({ path })
    if (pageData === null) {
      return false
    }

    return pageData._id
  }

  pageSchema.statics.isExistById = async function(id) {
    const pageData = await Page.findOne({ _id: id })
    if (pageData === null) {
      return false
    }

    return pageData._id
  }

  pageSchema.statics.findListByPageIds = function(ids, options) {
    options = options || {}
    const limit = options.limit || 50
    const offset = options.skip || 0

    return (
      Page.find({ _id: { $in: ids } })
        // .sort({createdAt: -1}) // TODO optionize
        .skip(offset)
        .limit(limit)
        .populate([
          { path: 'creator', model: 'User' },
          { path: 'revision', model: 'Revision', populate: { path: 'author' } },
        ])
        .exec()
    )
  }

  pageSchema.statics.findPageByRedirectTo = async function(path) {
    const pageData = await Page.findOne({ redirectTo: path })

    if (pageData === null) {
      throw new Error('Page not found')
    }

    return pageData
  }

  pageSchema.statics.findPagesByIds = function(ids) {
    return Page.find({
      _id: { $in: ids },
      redirectTo: null,
    })
      .populate([
        { path: 'creator', model: 'User' },
        {
          path: 'revision',
          model: 'Revision',
          populate: {
            path: 'author',
            model: 'User',
          },
        },
      ])
      .exec()
  }

  pageSchema.statics.findListByCreator = function(user, option, currentUser) {
    const limit = option.limit || 50
    const offset = option.offset || 0
    const conditions: any = {
      creator: user._id,
      redirectTo: null,
      $or: [{ status: null }, { status: STATUS_PUBLISHED }],
    }

    if (!user.equals(currentUser._id)) {
      conditions.grant = GRANT_PUBLIC
    }

    return Page.find(conditions)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate({ path: 'revision', populate: { path: 'author' } })
      .exec()
  }

  /**
   * Bulk get (for internal only)
   */
  pageSchema.statics.getStreamOfFindAll = function(options = {}) {
    const publicOnly = options.publicOnly !== false
    const criteria: any = { redirectTo: null }

    if (publicOnly) {
      criteria.grant = GRANT_PUBLIC
    }

    return Page.find(criteria)
      .populate([
        { path: 'creator', model: 'User' },
        { path: 'revision', model: 'Revision' },
      ])
      .lean()
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
    const pathCondition: Record<string, string | RegExp>[] = []
    const includeDeletedPage = option.includeDeletedPage || false

    if (!option) {
      option = { sort: 'updatedAt', desc: -1, offset: 0, limit: 50 }
    }
    const opt = {
      sort: option.sort || 'updatedAt',
      desc: option.desc || -1,
      offset: option.offset || 0,
      limit: option.limit === 0 ? 0 : option.limit || 50,
    }
    const sortOpt = {}
    sortOpt[opt.sort] = opt.desc
    const queryReg = new RegExp('^' + path)
    // var sliceOption = option.revisionSlice || { $slice: 1 }

    pathCondition.push({ path: queryReg })
    if (path.match(/\/$/)) {
      debug('Page list by ending with /, so find also upper level page')
      pathCondition.push({ path: path.substr(0, path.length - 1) })
    }

    // FIXME: might be heavy
    const q = Page.find({
      redirectTo: null,
      $or: [
        { grant: null },
        { grant: GRANT_PUBLIC },
        { grant: GRANT_RESTRICTED, grantedUsers: userData._id },
        { grant: GRANT_SPECIFIED, grantedUsers: userData._id },
        { grant: GRANT_OWNER, grantedUsers: userData._id },
      ],
    })
      .populate({ path: 'revision', populate: { path: 'author', model: 'User' } })
      .and({
        $or: pathCondition,
      } as any)
      .sort(sortOpt)
      .skip(opt.offset)
      .limit(opt.limit)

    if (!includeDeletedPage) {
      q.and({
        $or: [{ status: null }, { status: STATUS_PUBLISHED }],
      } as any)
    }

    return q.exec()
  }

  pageSchema.statics.findChildrenByPath = async function(path, userData, option) {
    path = addTrailingSlash(path)
    return Page.findListByStartWith(path, userData, { limit: 0, ...option })
  }

  pageSchema.statics.findUnfurlablePages = async function(type, array, grants = [GRANT_PUBLIC, GRANT_RESTRICTED]) {
    const page = await Page.find({
      [type]: { $in: array },
      $or: grants.map(grant => ({ grant })),
    })
    return page
  }

  pageSchema.statics.findUnfurlablePagesByIds = async function(ids) {
    return Page.findUnfurlablePages('_id', ids)
  }

  pageSchema.statics.findUnfurlablePagesByPaths = async function(paths) {
    // `GRANT_RESTRICTED` pages can not be accessed using path
    return Page.findUnfurlablePages('path', paths, [GRANT_PUBLIC])
  }

  pageSchema.statics.updatePageProperty = function(page, updateData) {
    return Page.updateOne({ _id: page._id }, { $set: updateData })
  }

  pageSchema.statics.updateGrant = async function(page, grant, userData) {
    page.grant = grant
    if (grant == GRANT_PUBLIC) {
      page.grantedUsers = []
    } else {
      page.grantedUsers = []
      page.grantedUsers.addToSet(userData._id)
    }

    const data = await page.save()

    debug('Page.updateGrant, saved grantedUsers.', (data && data.path) || {})

    return data
  }

  // Instance method でいいのでは
  pageSchema.statics.pushToGrantedUsers = function(page, userData) {
    if (!page.grantedUsers || !Array.isArray(page.grantedUsers)) {
      page.grantedUsers = []
    }
    page.grantedUsers.addToSet(userData)
    return page.save()
  }

  pageSchema.statics.pushRevision = async function(pageData, newRevision, user) {
    const isCreate = pageData.revision === undefined
    if (isCreate) {
      debug('pushRevision on Create')
    }

    await newRevision.save()

    debug('Successfully saved new revision', newRevision)

    pageData.revision = newRevision
    pageData.lastUpdateUser = user
    pageData.updatedAt = Date.now()

    const data = pageData.save()

    if (!isCreate) {
      debug('pushRevision on Update')
    }

    return data
  }

  pageSchema.statics.createPage = async function(path, body, user, options) {
    const Revision = crowi.model('Revision')
    const format = options.format || 'markdown'
    let grant = options.grant || GRANT_PUBLIC
    const redirectTo = options.redirectTo || null

    // force public
    if (isPortalPath(path)) {
      grant = GRANT_PUBLIC
    }

    const pageData = await Page.findOne({ path })
    if (pageData) {
      throw new Error('Cannot create new page to existed path')
    }

    const newPage = await Page.create({
      path,
      creator: user,
      lastUpdateUser: user,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      redirectTo: redirectTo,
      grant: grant,
      status: STATUS_PUBLISHED,
      grantedUsers: user ? [user] : [],
    })

    const newRevision = Revision.prepareRevision(newPage, body, user, { format })
    try {
      const revisionData = await Page.pushRevision(newPage, newRevision, user)
      pageEvent.emit('create', revisionData, user)
      return revisionData
    } catch (err) {
      debug('Push Revision Error on create page', err)
      throw err
    }
  }

  pageSchema.statics.updatePage = async function(pageData, body, user, options = {}) {
    const Revision = crowi.model('Revision')
    const Bookmark = crowi.model('Bookmark')
    const grant = options.grant || null
    // update existing page
    const newRevision = Revision.prepareRevision(pageData, body, user)

    await Page.pushRevision(pageData, newRevision, user)
    const bookmarkCount = await Bookmark.countByPageId(pageData._id)

    if (grant != pageData.grant) {
      const data = await Page.updateGrant(pageData, grant, user)
      pageEvent.emit('update', data, user, bookmarkCount)
      return data
    }
    pageEvent.emit('update', pageData, user, bookmarkCount)
    return pageData
  }

  pageSchema.statics.deletePage = async function(pageData, user) {
    const Share = crowi.model('Share')
    const newPath = Page.getDeletedPageName(pageData.path)
    if (Page.isDeletableName(pageData.path)) {
      await Page.updatePageProperty(pageData, { status: STATUS_DELETED, lastUpdateUser: user })
      await Share.deleteByPageId(pageData._id)
      pageData.status = STATUS_DELETED

      // ページ名が /trash/ 以下に存在する場合、おかしなことになる
      // が、 /trash 以下にページが有るのは、個別に作っていたケースのみ。
      // 一応しばらく前から uncreatable pages になっているのでこれでいいことにする
      debug('Deleted the page, and rename it', pageData.path, newPath)
      return Page.rename(pageData, newPath, user, { createRedirectPage: true })
    }
    throw new Error('Page is not deletable.')
  }

  pageSchema.statics.revertDeletedPage = async function(pageData, user) {
    const newPath = Page.getRevertDeletedPageName(pageData.path)

    // 削除時、元ページの path には必ず redirectTo 付きで、ページが作成される。
    // そのため、そいつは削除してOK
    // が、redirectTo ではないページが存在している場合それは何かがおかしい。(データ補正が必要)
    const originPageData = await Page.findPageByPath(newPath)
    if (originPageData.redirectTo !== pageData.path) {
      throw new Error('The new page of to revert is exists and the redirect path of the page is not the deleted page.')
    }

    await Page.completelyDeletePage(originPageData)
    await Page.updatePageProperty(pageData, { status: STATUS_PUBLISHED, lastUpdateUser: user })
    pageData.status = STATUS_PUBLISHED

    debug('Revert deleted the page, and rename again it', pageData, newPath)
    await Page.rename(pageData, newPath, user, {})
    pageData.path = newPath
    return pageData
  }

  /**
   * This is danger.
   */
  pageSchema.statics.completelyDeletePage = async function(pageData, user) {
    // Delete Bookmarks, Attachments, Revisions, Pages and emit delete
    const Bookmark = crowi.model('Bookmark')
    const Attachment = crowi.model('Attachment')
    const Comment = crowi.model('Comment')
    const Activity = crowi.model('Activity')
    const pageId = pageData._id

    debug('Completely delete', pageData.path)

    await Bookmark.removeBookmarksByPageId(pageId)
    await Attachment.removeAttachmentsByPageId(pageId)
    await Comment.removeCommentsByPageId(pageId)
    await Page.removePageById(pageId)
    await Page.removeRedirectOriginPageByPath(pageData.path)
    await Activity.removeByPage(pageId)

    pageEvent.emit('delete', pageData, user) // update as renamed page

    return pageData
  }

  pageSchema.statics.removePage = async function(pageData) {
    const Revision = crowi.model('Revision')
    const { _id } = pageData

    debug('Remove phisically, the page', _id)
    try {
      await Page.deleteOne({ _id })
    } catch (err) {
      debug(' --> error', _id)
      throw err
    }
    await Revision.removeRevisionsByPath(pageData.path)
    return pageData
  }

  pageSchema.statics.removePageById = async function(pageId) {
    const pageData = await Page.findPageById(pageId)
    await Page.removePage(pageData)
    return pageData
  }

  pageSchema.statics.removePageByPath = async function(pagePath) {
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

  pageSchema.statics.rename = async function(pageData, newPagePath, user, options) {
    const Revision = crowi.model('Revision')
    const path = pageData.path
    const createRedirectPage = options.createRedirectPage || false
    const preserveUpdatedAt = options.preserveUpdatedAt || false

    const updatedAt = preserveUpdatedAt ? {} : { updatedAt: Date.now() }
    const updateData = { path: newPagePath, lastUpdateUser: user, ...updatedAt }

    // pageData の path を変更
    await Page.updatePageProperty(pageData, updateData)
    // reivisions の path を変更
    const data = await Revision.updateRevisionListByPath(path, { path: newPagePath })
    pageData.path = newPagePath

    if (createRedirectPage) {
      const body = 'redirect ' + newPagePath
      return Page.createPage(path, body, user, { redirectTo: newPagePath })
    }
    pageEvent.emit('update', pageData, user) // update as renamed page
    return data
  }

  pageSchema.statics.getPathMap = function(paths, search, replace) {
    search = removeTrailingSlash(search)
    replace = this.normalizePath(replace)
    const renamePath = path => path.replace(search, replace)
    // { [oldPath]: newPath }
    return paths.map(({ path }) => [path, renamePath(path)]).reduce((l, [k, v]) => Object.assign(l, { [k]: v }), {})
  }

  pageSchema.statics.checkPagesRenamable = async function(paths, user) {
    let error = false
    let errors = {}
    for (const path of paths) {
      const e: string[] = []
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
    const { createRedirectPage = false, preserveUpdatedAt = true } = options
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
          const options = {
            createRedirectPage: !isPortalPath(newPath) && createRedirectPage,
            preserveUpdatedAt,
          }
          const oldPage = await Page.findPageByPath(oldPath)
          await Page.rename(oldPage, newPath, user, options)
          return oldPage
        } catch (err) {
          throw new Error(`Failed to update page (${oldPath}).`)
        }
      }),
    )
  }

  pageSchema.statics.allPageCount = function() {
    return Page.countDocuments({ redirectTo: null, grant: GRANT_PUBLIC }) // TODO: option にする
  }

  pageSchema.methods.getNotificationTargetUsers = async function() {
    const Comment = crowi.model('Comment')
    const Revision = crowi.model('Revision')

    const [commentCreators, revisionAuthors] = await Promise.all([Comment.findCreatorsByPage(this), Revision.findAuthorsByPage(this)])
    debug('commentCreators', commentCreators)
    debug('revisionAuthors', revisionAuthors)

    const targetUsers = [this.creator].concat(commentCreators, revisionAuthors)
    debug('targetUsers', targetUsers)

    const uniqueChecker = {}
    const uniqueUsers: Types.ObjectId[] = []
    targetUsers.forEach(function(user) {
      const userId = user.toString()
      if (uniqueChecker[userId] !== 1) {
        uniqueUsers.push(user)
        uniqueChecker[userId] = 1
      }
    })
    debug('uniqueUsers', uniqueUsers)

    return uniqueUsers
  }

  pageSchema.post('save', savedPage => {
    const Backlink = crowi.model('Backlink')
    Backlink.createBySavedPage(savedPage)
      .then(result => {
        debug(result)
      })
      .catch(err => err)
  })

  pageSchema.statics.GRANT_PUBLIC = GRANT_PUBLIC
  pageSchema.statics.GRANT_RESTRICTED = GRANT_RESTRICTED
  pageSchema.statics.GRANT_SPECIFIED = GRANT_SPECIFIED
  pageSchema.statics.GRANT_OWNER = GRANT_OWNER
  pageSchema.statics.PAGE_GRANT_ERROR = PAGE_GRANT_ERROR
  pageSchema.statics.TYPE_PORTAL = TYPE_PORTAL
  pageSchema.statics.TYPE_PUBLIC = TYPE_PUBLIC
  pageSchema.statics.TYPE_USER = TYPE_USER

  const Page = model<PageDocument, PageModel>('Page', pageSchema)

  return Page
}
