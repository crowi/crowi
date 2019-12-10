import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'
import mongoosePaginate from 'mongoose-paginate'
import crypto from 'crypto'
import async from 'async'

const STATUS_REGISTERED = 1
const STATUS_ACTIVE = 2
const STATUS_SUSPENDED = 3
const STATUS_DELETED = 4
const STATUS_INVITED = 5
const LANG_EN = 'en'
const LANG_EN_US = 'en-US'
const LANG_EN_GB = 'en-GB'
const LANG_JA = 'ja'
const PAGE_ITEMS = 50

export interface UserDocument extends Document {
  _id: Types.ObjectId
  userId: string
  image: string | null
  googleId: string | null
  githubId: string | null
  name: string
  username: string
  email: string
  introduction: string
  password: string
  apiToken: string
  lang: 'en' | 'en-US' | 'en-GB' | 'ja'
  status: number
  createdAt: Date
  admin: boolean

  isPasswordSet(): boolean
  isPasswordValid(password: string): boolean
  setPassword(password: string): this
  isEmailSet(): boolean
  updatePassword(password: string, callback: (err: Error, userData: UserDocument) => void): any
  updateApiToken(): Promise<UserDocument>
  updateImage(image, callback: (err: Error, userData: UserDocument) => void): any
  updateEmail(email: string): any
  deleteImage(callback): any
  updateGoogleId(googleId): Promise<UserDocument>
  deleteGoogleId(): Promise<UserDocument>
  updateGitHubId(githubId): Promise<UserDocument>
  deleteGitHubId(): Promise<UserDocument>
  countValidThirdPartyIds(): number
  hasValidThirdPartyId(): boolean
  canDisconnectThirdPartyId(): boolean
  activateInvitedUser(username, name, password, callback: (err: Error, userData: UserDocument) => void): any
  removeFromAdmin(callback: (err: Error, userData: UserDocument) => void): any
  makeAdmin(callback: (err: Error, userData: UserDocument) => void): any
  statusActivate(callback: (err: Error, userData: UserDocument) => void): any
  statusSuspend(callback: (err: Error, userData: UserDocument) => void): any
  statusDelete(callback: (err: Error, userData: UserDocument) => void): any
  populateSecrets(): Promise<any>
}

export interface UserModel extends Model<UserDocument> {
  paginate: any

  getLanguageLabels(): object
  getUserStatusLabels(): any
  isEmailValid(email): boolean
  isGitHubAccountValid(organizations): boolean
  findUsers(options, callback: (err: Error, userData: UserDocument[]) => void)
  findAllUsers(option?): Promise<UserDocument[]>
  findUsersByIds(ids, option?): Promise<UserDocument[]>
  findAdmins(callback: (err: Error, admins: UserDocument[]) => void): void
  findUsersWithPagination(options, query, callback): any
  findUsersByPartOfEmail(emailPart, options): any
  findUserByUsername(username): Promise<UserDocument | null>
  findUserByApiToken(apiToken): Promise<UserDocument | null>
  findUserByGoogleId(googleId): Promise<UserDocument | null>
  findUserByGitHubId(githubId): Promise<UserDocument | null>
  findUserByEmail(email): Promise<UserDocument | null>
  findUserByEmailAndPassword(email: string, password: string): Promise<UserDocument | null>
  isRegisterableUsername(username, callback: (registerable: boolean) => void): void
  isRegisterable(email, username, callback: (registerable: boolean, detail: { email?: boolean; username?: boolean }) => void): void
  removeCompletelyById(id, callback: (err: Error | null, userData: 1 | null) => void): any
  resetPasswordByRandomString(id: Types.ObjectId): Promise<{ user: UserDocument; newPassword: string }>
  createUsersByInvitation(emailList, toSendEmail, callback): any
  createUserByEmailAndPassword(name, username, email, password, lang, callback): any
  createUserPictureFilePath(user: UserDocument, ext: string): string
  getUsernameByPath(path): string | null

  STATUS_REGISTERED: number
  STATUS_ACTIVE: number
  STATUS_SUSPENDED: number
  STATUS_DELETED: number
  STATUS_INVITED: number
  PAGE_ITEMS: number
  LANG_EN: string
  LANG_EN_US: string
  LANG_EN_GB: string
  LANG_JA: string
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:user')

  const userEvent = crowi.event('User')

  const userSchema = new Schema<UserDocument, UserModel>({
    userId: String,
    image: String,
    googleId: String,
    githubId: String,
    name: { type: String, index: true },
    username: { type: String, index: true },
    email: { type: String, required: true, index: true },
    introduction: { type: String },
    password: { type: String, select: false },
    apiToken: { type: String, select: false },
    lang: {
      type: String,
      enum: Object.values(getLanguageLabels()),
      default: LANG_EN_US,
    },
    status: { type: Number, required: true, default: STATUS_ACTIVE, index: true },
    createdAt: { type: Date, default: Date.now },
    admin: { type: Boolean, default: 0, index: true },
  })
  userSchema.plugin(mongoosePaginate)

  userEvent.on('activated', userEvent.onActivated)

  function decideUserStatusOnRegistration() {
    const Config = crowi.model('Config')
    const config = crowi.getConfig()

    if (!config.crowi) {
      return STATUS_ACTIVE // is this ok?
    }

    // status decided depends on registrationMode
    switch (config.crowi['security:registrationMode']) {
      case Config.SECURITY_REGISTRATION_MODE_OPEN:
        return STATUS_ACTIVE
      case Config.SECURITY_REGISTRATION_MODE_RESTRICTED:
      case Config.SECURITY_REGISTRATION_MODE_CLOSED: // 一応
        return STATUS_REGISTERED
      default:
        return STATUS_ACTIVE // どっちにすんのがいいんだろうな
    }
  }

  function generateRandomTempPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!=-_'
    let password = ''
    const len = 12

    for (let i = 0; i < len; i++) {
      const randomPoz = Math.floor(Math.random() * chars.length)
      password += chars.substring(randomPoz, randomPoz + 1)
    }

    return password
  }

  function generatePassword(password) {
    const hasher = crypto.createHash('sha256')
    hasher.update(crowi.env.PASSWORD_SEED + password)

    return hasher.digest('hex')
  }

  function generateApiToken(user) {
    const hasher = crypto.createHash('sha256')
    hasher.update(new Date().getTime() + user._id)

    return hasher.digest('base64')
  }

  function getLanguageLabels() {
    const lang = {
      LANG_EN,
      LANG_EN_US,
      LANG_EN_GB,
      LANG_JA,
    }

    return lang
  }

  userSchema.methods.isPasswordSet = function() {
    if (this.password) {
      return true
    }
    return false
  }

  userSchema.methods.isPasswordValid = function(password) {
    return this.password == generatePassword(password)
  }

  userSchema.methods.setPassword = function(password) {
    this.password = generatePassword(password)
    return this
  }

  userSchema.methods.isEmailSet = function() {
    if (this.email) {
      return true
    }
    return false
  }

  userSchema.methods.updatePassword = function(password, callback) {
    this.setPassword(password)
    this.save(function(err, userData) {
      return callback(err, userData)
    })
  }

  userSchema.methods.updateApiToken = function() {
    this.apiToken = generateApiToken(this)
    return this.save()
  }

  userSchema.methods.updateImage = function(image, callback) {
    this.image = image
    this.save(function(err, userData) {
      return callback(err, userData)
    })
  }

  userSchema.methods.updateEmail = function(email) {
    this.email = email
    return this.save()
  }

  userSchema.methods.deleteImage = function(callback) {
    return this.updateImage(null, callback)
  }

  userSchema.methods.updateGoogleId = function(googleId) {
    this.googleId = googleId
    return this.save()
  }

  userSchema.methods.deleteGoogleId = function() {
    return this.updateGoogleId(null)
  }

  userSchema.methods.updateGitHubId = function(githubId) {
    this.githubId = githubId
    return this.save()
  }

  userSchema.methods.deleteGitHubId = function() {
    return this.updateGitHubId(null)
  }

  userSchema.methods.countValidThirdPartyIds = function() {
    const Config = crowi.model('Config')
    const config = crowi.getConfig()
    const googleId = Config.googleLoginEnabled(config) && this.googleId
    const githubId = Config.githubLoginEnabled(config) && this.githubId
    const validIds = [googleId, githubId].filter(Boolean)
    return validIds.length
  }

  userSchema.methods.hasValidThirdPartyId = function() {
    return this.countValidThirdPartyIds() > 0
  }

  userSchema.methods.canDisconnectThirdPartyId = function() {
    const Config = crowi.model('Config')
    const config = crowi.getConfig()
    return !Config.isDisabledPasswordAuth(config) || this.countValidThirdPartyIds() > 1
  }

  userSchema.methods.activateInvitedUser = function(username, name, password, callback) {
    this.setPassword(password)
    this.name = name
    this.username = username
    this.status = STATUS_ACTIVE
    this.save(function(err, userData) {
      userEvent.emit('activated', userData)
      return callback(err, userData)
    })
  }

  userSchema.methods.removeFromAdmin = function(callback) {
    debug('Remove from admin', this)
    this.admin = false
    this.save(function(err, userData) {
      return callback(err, userData)
    })
  }

  userSchema.methods.makeAdmin = function(callback) {
    debug('Admin', this)
    this.admin = true
    this.save(function(err, userData) {
      return callback(err, userData)
    })
  }

  userSchema.methods.statusActivate = function(callback) {
    debug('Activate User', this)
    this.status = STATUS_ACTIVE
    this.save(function(err, userData) {
      userEvent.emit('activated', userData)
      return callback(err, userData)
    })
  }

  userSchema.methods.statusSuspend = function(callback) {
    debug('Suspend User', this)
    this.status = STATUS_SUSPENDED
    if (this.email === undefined || this.email === null) {
      // migrate old data
      this.email = '-'
    }
    if (this.name === undefined || this.name === null) {
      // migrate old data
      this.name = '-' + Date.now()
    }
    if (this.username === undefined || this.username === null) {
      // migrate old data
      this.username = '-'
    }
    this.save(function(err, userData) {
      return callback(err, userData)
    })
  }

  userSchema.methods.statusDelete = function(callback) {
    debug('Delete User', this)
    this.status = STATUS_DELETED
    this.password = ''
    this.email = 'deleted@deleted'
    this.googleId = null
    this.image = null
    this.save(function(err, userData) {
      return callback(err, userData)
    })
  }

  userSchema.methods.populateSecrets = async function() {
    return User.findById(this._id, '+password +apiToken').exec()
  }

  userSchema.statics.getLanguageLabels = getLanguageLabels
  userSchema.statics.getUserStatusLabels = function() {
    const userStatus = {}
    userStatus[STATUS_REGISTERED] = '承認待ち'
    userStatus[STATUS_ACTIVE] = 'Active'
    userStatus[STATUS_SUSPENDED] = 'Suspended'
    userStatus[STATUS_DELETED] = 'Deleted'
    userStatus[STATUS_INVITED] = '招待済み'

    return userStatus
  }

  userSchema.statics.isEmailValid = function(email) {
    const config = crowi.getConfig()
    const whitelist = config.crowi['security:registrationWhiteList']

    if (Array.isArray(whitelist) && whitelist.length > 0) {
      return config.crowi['security:registrationWhiteList'].some(function(allowedEmail) {
        const re = new RegExp(allowedEmail + '$')
        return re.test(email)
      })
    }

    return true
  }

  userSchema.statics.isGitHubAccountValid = function(organizations) {
    const config = crowi.getConfig()
    const org = config.crowi['github:organization']

    const orgs = organizations || []

    return !org || orgs.includes(org)
  }

  userSchema.statics.findUsers = function(options, callback) {
    const sort = options.sort || { status: 1, createdAt: 1 }

    this.find()
      .sort(sort)
      .skip(options.skip || 0)
      .limit(options.limit || 21)
      .exec(function(err, userData) {
        callback(err, userData)
      })
  }

  userSchema.statics.findAllUsers = function(option) {
    var option = option || {}
    const sort = option.sort || { createdAt: -1 }
    let status = option.status || [STATUS_ACTIVE, STATUS_SUSPENDED]
    const fields = option.fields

    if (!Array.isArray(status)) {
      status = [status]
    }

    return User.find()
      .or(
        status.map(s => {
          return { status: s }
        }),
      )
      .select(fields)
      .sort(sort)
      .exec()
  }

  userSchema.statics.findUsersByIds = function(ids, option) {
    var option = option || {}
    const sort = option.sort || { createdAt: -1 }
    const status = option.status || STATUS_ACTIVE
    const fields = option.fields

    return User.find({ _id: { $in: ids }, status: status })
      .select(fields)
      .sort(sort)
      .exec()
  }

  userSchema.statics.findAdmins = function(callback) {
    this.find({ admin: true }).exec(function(err, admins) {
      debug('Admins: ', admins)
      callback(err, admins)
    })
  }

  userSchema.statics.findUsersWithPagination = function(options, query, callback) {
    const sort = options.sort || { status: 1, username: 1, createdAt: 1 }

    this.paginate(
      query,
      { page: options.page || 1, limit: options.limit || PAGE_ITEMS },
      function(err, result) {
        if (err) {
          debug('Error on pagination:', err)
          return callback(err, null)
        }

        return callback(err, result)
      },
      { sortBy: sort },
    )
  }

  userSchema.statics.findUsersByPartOfEmail = function(emailPart, options) {
    const status = options.status || null
    const emailPartRegExp = new RegExp(emailPart.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))

    const query = User.find({ email: emailPartRegExp })

    if (status) {
      query.and({ status } as any)
    }

    return query.limit(PAGE_ITEMS + 1).exec()
  }

  userSchema.statics.findUserByUsername = function(username) {
    return User.findOne({ username }).exec()
  }

  userSchema.statics.findUserByApiToken = function(apiToken) {
    return User.findOne({ apiToken }).exec()
  }

  userSchema.statics.findUserByGoogleId = function(googleId) {
    return User.findOne({ googleId }).exec()
  }

  userSchema.statics.findUserByGitHubId = function(githubId) {
    return User.findOne({ githubId }).exec()
  }

  userSchema.statics.findUserByEmail = function(email) {
    return User.findOne({ email }).exec()
  }

  userSchema.statics.findUserByEmailAndPassword = function(email, password) {
    const hashedPassword = generatePassword(password)
    return User.findOne({ email, password: hashedPassword }).exec()
  }

  userSchema.statics.isRegisterableUsername = async function(username, callback) {
    const userData = await User.findOne({ username })
    if (userData) {
      return callback(false)
    }

    return callback(true)
  }

  userSchema.statics.isRegisterable = async function(email, username, callback) {
    let emailUsable = true
    let usernameUsable = true
    let userData: UserDocument | null = null

    // username check
    userData = await User.findOne({ username })
    if (userData) {
      usernameUsable = false
    }

    // email check
    userData = await User.findOne({ email })
    if (userData) {
      emailUsable = false
    }

    if (!emailUsable || !usernameUsable) {
      return callback(false, { email: emailUsable, username: usernameUsable })
    }

    return callback(true, {})
  }

  userSchema.statics.removeCompletelyById = function(id, callback) {
    User.findById(id, function(err, userData) {
      if (!userData) {
        return callback(err, null)
      }

      debug('Removing user:', userData)
      // 物理削除可能なのは、招待中ユーザーのみ
      // 利用を一度開始したユーザーは論理削除のみ可能
      if (userData.status !== STATUS_INVITED) {
        return callback(new Error('Cannot remove completely the user whoes status is not INVITED'), null)
      }

      userData.remove(function(err) {
        if (err) {
          return callback(err, null)
        }

        return callback(null, 1)
      })
    })
  }

  userSchema.statics.resetPasswordByRandomString = async function(id) {
    const userData = await User.findById(id)
    if (!userData) {
      throw new Error('User not found')
    }

    // is updatable check
    // if (userData.isUp
    const newPassword = generateRandomTempPassword()
    userData.setPassword(newPassword)
    const user = await userData.save()

    return { user, newPassword }
  }

  userSchema.statics.createUsersByInvitation = function(emailList, toSendEmail, callback) {
    const createdUserList: {
      email: string
      password: string | null
      user: UserDocument | null
    }[] = []
    const config = crowi.getConfig()
    const mailer = crowi.getMailer()

    if (!Array.isArray(emailList)) {
      debug('emailList is not array')
    }

    async.each(
      emailList,
      function(email, next) {
        const newUser = new User()
        let password

        email = email.trim()

        // email check
        // TODO: 削除済みはチェック対象から外そう〜
        User.findOne({ email }, function(err, user) {
          // The user is exists
          if (user) {
            createdUserList.push({ email, password: null, user: null })

            return next()
          }

          password = Math.random()
            .toString(36)
            .slice(-16)

          newUser.email = email
          newUser.setPassword(password)
          newUser.createdAt = Date.now() as any
          newUser.status = STATUS_INVITED

          newUser.save(function(err, user) {
            if (err) {
              createdUserList.push({ email, password: null, user: null })
              debug('save failed!! ', email)
            } else {
              createdUserList.push({ email, password, user })
              debug('saved!', email)
            }

            next()
          })
        })
      },
      function(err) {
        if (err) {
          debug('error occured while iterate email list')
        }

        if (toSendEmail) {
          // TODO: メール送信部分のロジックをサービス化する
          async.each(
            createdUserList,
            function(user, next) {
              if (user.password === null) {
                return next()
              }

              mailer.send(
                {
                  to: user.email,
                  subject: 'Invitation to ' + config.crowi['app:title'],
                  template: 'admin/userInvitation.txt',
                  vars: {
                    email: user.email,
                    password: user.password,
                    url: config.crowi['app:url'],
                    appTitle: config.crowi['app:title'],
                  },
                },
                function(err, s) {
                  debug('completed to send email: ', err, s)
                  next()
                },
              )
            },
            function(err) {
              debug('Sending invitation email completed.', err)
            },
          )
        }

        debug('createdUserList!!! ', createdUserList)
        return callback(null, createdUserList)
      },
    )
  }

  userSchema.statics.createUserByEmailAndPassword = function(name, username, email, password, lang, callback) {
    const newUser = new User()

    newUser.name = name
    newUser.username = username
    newUser.email = email
    newUser.setPassword(password)
    newUser.lang = lang
    newUser.createdAt = Date.now() as any
    newUser.status = decideUserStatusOnRegistration()

    newUser.save(function(err, userData) {
      if (userData.status == STATUS_ACTIVE) {
        userEvent.emit('activated', userData)
      }
      return callback(err, userData)
    })
  }

  userSchema.statics.createUserPictureFilePath = function(user, ext) {
    ext = '.' + ext

    return 'user/' + user._id + ext
  }

  userSchema.statics.getUsernameByPath = function(path) {
    let username = null
    let m
    if ((m = path.match(/^\/user\/([^/]+)\/?/))) {
      username = m[1]
    }

    return username
  }

  userSchema.statics.STATUS_REGISTERED = STATUS_REGISTERED
  userSchema.statics.STATUS_ACTIVE = STATUS_ACTIVE
  userSchema.statics.STATUS_SUSPENDED = STATUS_SUSPENDED
  userSchema.statics.STATUS_DELETED = STATUS_DELETED
  userSchema.statics.STATUS_INVITED = STATUS_INVITED
  userSchema.statics.PAGE_ITEMS = PAGE_ITEMS

  userSchema.statics.LANG_EN = LANG_EN
  userSchema.statics.LANG_EN_US = LANG_EN_US
  userSchema.statics.LANG_EN_GB = LANG_EN_US
  userSchema.statics.LANG_JA = LANG_JA

  const User = model<UserDocument, UserModel>('User', userSchema)

  return User
}
