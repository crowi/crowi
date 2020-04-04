import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import ApiResponse from '../utils/apiResponse'
import { UserDocument } from 'server/models/user'
import { getPath } from 'server/utils/ssr'
import { getAppContext } from 'server/utils/view'

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:admin')
  const models = crowi.models
  const User = models.User
  const Config = models.Config
  const MAX_PAGE_LIST = 5
  const actions = {} as any
  actions.api = {} as any

  const searchEvent = crowi.event('Search')

  function createPager(total, limit, page, pagesCount, maxPageList) {
    const pager: {
      page: any
      pagesCount: number
      pages: number[]
      total: number
      previous: number | null
      previousDots: boolean | null
      next: number | null
      nextDots: boolean | null
    } = {
      page,
      pagesCount,
      pages: [],
      total,
      previous: null,
      previousDots: false,
      next: null,
      nextDots: false,
    }

    if (page > 1) {
      pager.previous = page - 1
    }

    if (page < pagesCount) {
      pager.next = page + 1
    }

    let pagerMin = Math.max(1, Math.ceil(page - maxPageList / 2))
    let pagerMax = Math.min(pagesCount, Math.floor(page + maxPageList / 2))
    if (pagerMin === 1) {
      if (MAX_PAGE_LIST < pagesCount) {
        pagerMax = MAX_PAGE_LIST
      } else {
        pagerMax = pagesCount
      }
    }
    if (pagerMax === pagesCount) {
      if (pagerMax - MAX_PAGE_LIST < 1) {
        pagerMin = 1
      } else {
        pagerMin = pagerMax - MAX_PAGE_LIST
      }
    }

    pager.previousDots = null
    if (pagerMin > 1) {
      pager.previousDots = true
    }

    pager.nextDots = null
    if (pagerMax < pagesCount) {
      pager.nextDots = true
    }

    for (let i = pagerMin; i <= pagerMax; i++) {
      pager.pages.push(i)
    }

    return pager
  }

  actions.index = function(req: Request, res: Response) {
    return res.render(getPath(crowi, 'AdminPage'), { i18n: req.i18n, context: getAppContext(crowi, req) })
  }

  actions.api.index = function(req: Request, res: Response) {
    const searcher = crowi.getSearcher()

    return res.json(ApiResponse.success({ searchConfigured: !!searcher }))
  }

  actions.api.app = {}
  actions.api.app.index = async function(req: Request, res: Response) {
    const config = crowi.getConfig()
    const settingForm = config.crowi
    const registrationMode = Config.getRegistrationModeLabels()
    const isUploadable = Config.isUploadable(config)

    return res.json(ApiResponse.success({ settingForm, registrationMode, isUploadable }))
  }

  actions.notification = {}
  actions.api.notification = {}
  actions.api.notification.index = async function(req: Request, res: Response) {
    const config = crowi.getConfig()
    const UpdatePost = crowi.model('UpdatePost')
    const hasSlackConfig = Config.hasSlackConfig(config)
    const hasSlackToken = Config.hasSlackToken(config)
    const slack = crowi.slack
    const appUrl = config.crowi['app:url']

    const defaultSlackSetting = { 'slack:clientId': '', 'slack:clientSecret': '' }
    const slackSetting = hasSlackConfig ? config.notification : defaultSlackSetting
    const slackAuthUrl = hasSlackConfig ? slack.getAuthorizeURL() : ''

    const settings = await UpdatePost.findAll()
    return res.json(ApiResponse.success({ settings, slackSetting, hasSlackConfig, hasSlackToken, slackAuthUrl, appUrl }))
  }

  actions.api.notification.slackSetting = async function(req: Request, res: Response) {
    const { slackSetting } = req.form

    if (!req.form.isValid) {
      return res.json(ApiResponse.error(req.form.errors.join('\n')))
    }

    try {
      await Config.updateConfigByNamespace('notification', slackSetting)
      return res.json(ApiResponse.success({ message: 'Updated Slack setting.' }))
    } catch (err) {
      return res.json(ApiResponse.error(err.message))
    }
  }

  actions.notification.slackAuth = async function(req: Request, res: Response) {
    const code = req.query.code

    if (!code || !Config.hasSlackConfig(req.config)) {
      return res.redirect('/admin/notification')
    }

    const slack = crowi.slack
    try {
      const token = await slack.getOauthAccessToken(code)
      try {
        Config.updateConfigByNamespace('notification', { 'slack:token': token })
        req.flash('successMessage', ['Successfully Connected!'])
      } catch (err) {
        req.flash('errorMessage', ['Failed to save access_token. Please try again.'])
      }
      return res.redirect('/admin/notification')
    } catch (error) {
      debug('oauth response ERROR', error)
      req.flash('errorMessage', ['Failed to fetch access_token. Please do connect again.'])
      return res.redirect('/admin/notification')
    }
  }

  actions.api.search = {}
  actions.api.search.buildIndex = async function(req: Request, res: Response) {
    const search = crowi.getSearcher()
    if (!search) {
      return res.json(ApiResponse.error('Searcher is not ready.'))
    }

    searchEvent.on('addPageProgress', (total, current, skip) => {
      crowi.getIo().sockets.emit('admin:addPageProgress', { total, current, skip })
    })
    searchEvent.on('finishAddPage', (total, current, skip) => {
      crowi.getIo().sockets.emit('admin:finishAddPage', { total, current, skip })
    })

    search
      .buildIndex()
      .then(() => {
        debug('Data is successfully indexed. ------------------ ✧✧')
      })
      .catch(err => {
        debug('Error caught.', err)
      })

    return res.json(ApiResponse.success({ message: 'Now re-building index ... this takes a while.' }))
  }

  actions.user = {}
  actions.api.user = {}
  actions.api.user.index = function(req: Request, res: Response) {
    var page = parseInt(req.query.page) || 1

    // uq means user query
    // q used by search box on header
    const uq = req.query.uq
    const query: {
      $or?: any
    } = {}

    if (uq) {
      const $regex = uq.trim().replace(' ', '|')
      query.$or = ['username', 'name', 'email'].map(v => ({
        [v]: {
          $regex,
          $options: 'i',
        },
      }))
    }

    User.findUsersWithPagination({ page: page }, query, (err, result) => {
      if (err) {
        debug(err)
        return res.json(
          ApiResponse.success({
            users: [],
            pager: null,
            uq: uq,
            error: err.message,
          }),
        )
      }

      const pager = createPager(result.total, result.limit, result.page, result.pages, MAX_PAGE_LIST)

      return res.json(
        ApiResponse.success({
          users: result.docs,
          pager: pager,
          uq,
        }),
      )
    })
  }

  actions.api.user.invite = function(req: Request, res: Response) {
    const { emailList, sendEmail } = req.form.inviteForm
    const toSendEmail = sendEmail || false

    if (!req.form.isValid) {
      return res.json(ApiResponse.error(req.form.errors.join('\n')))
    }

    User.createUsersByInvitation(emailList.split('\n'), toSendEmail, function(err, userList) {
      if (err === null) {
        return res.json(ApiResponse.success({ userList }))
      }
      debug(err, userList)
      return res.json(ApiResponse.error('招待に失敗しました。'))
    })
  }

  actions.api.user.makeAdmin = function(req: Request, res: Response) {
    var id = req.params.id
    User.findById(id, function(err, userData) {
      ;(userData as UserDocument).makeAdmin(function(err, userData) {
        if (err === null) {
          return res.json(ApiResponse.success({ message: `${userData.name}さんのアカウントを管理者に設定しました。` }))
        }
        debug(err, userData)
        return res.json(ApiResponse.error('更新に失敗しました。'))
      })
    })
  }

  actions.api.user.removeFromAdmin = function(req: Request, res: Response) {
    var id = req.params.id
    User.findById(id, function(err, userData) {
      ;(userData as UserDocument).removeFromAdmin(function(err, userData) {
        if (err === null) {
          return res.json(ApiResponse.success({ message: `${userData.name}さんのアカウントを管理者から外しました。` }))
        }
        debug(err, userData)
        return res.json(ApiResponse.error('更新に失敗しました。'))
      })
    })
  }

  actions.api.user.activate = function(req: Request, res: Response) {
    var id = req.params.id
    User.findById(id, function(err, userData) {
      ;(userData as UserDocument).statusActivate(function(err, userData) {
        if (err === null) {
          return res.json(ApiResponse.success({ message: `${userData.name}さんのアカウントを承認しました。` }))
        }
        debug(err, userData)
        return res.json(ApiResponse.error('更新に失敗しました。'))
      })
    })
  }

  actions.api.user.suspend = function(req: Request, res: Response) {
    var id = req.params.id

    User.findById(id, function(err, userData) {
      ;(userData as UserDocument).statusSuspend(function(err, userData) {
        if (err === null) {
          return res.json(ApiResponse.success({ message: `${userData.name}さんのアカウントを利用停止にしました。` }))
        }
        debug(err, userData)
        return res.json(ApiResponse.error('更新に失敗しました。'))
      })
    })
  }

  actions.user.remove = function(req: Request, res: Response) {
    // 未実装
    return res.redirect('/admin/users')
  }

  // これやったときの relation の挙動未確認
  actions.user.removeCompletely = function(req: Request, res: Response) {
    // ユーザーの物理削除
    var id = req.params.id

    User.removeCompletelyById(id, function(err, removed) {
      if (err) {
        debug('Error while removing user.', err, id)
        req.flash('errorMessage', '完全な削除に失敗しました。')
      } else {
        req.flash('successMessage', '削除しました')
      }
      return res.redirect('/admin/users')
    })
  }

  actions.api.user.resetPassword = function(req: Request, res: Response) {
    const id = req.body.user_id
    const User = crowi.model('User')

    User.resetPasswordByRandomString(id)
      .then(function(data) {
        return res.json(ApiResponse.success(data))
      })
      .catch(function(err) {
        debug('Error on reseting password', err)
        return res.json(ApiResponse.error('Error'))
      })
  }

  actions.api.user.updateEmail = async function(req: Request, res: Response) {
    const { user_id: id, email } = req.body
    const User = crowi.model('User')

    try {
      const user = await User.findById(id)
      if (!user) throw new Error('User not found')
      await user.updateEmail(email)
      return res.json(ApiResponse.success())
    } catch (err) {
      debug('Error on updating email', err)
      return res.json(ApiResponse.error('Error'))
    }
  }

  actions.api.top = {}
  actions.api.top.index = function(req: Request, res: Response) {
    const { version: crowiVersion } = crowi
    const searcher = crowi.getSearcher()
    const searchInfo = searcher
      ? {
          host: searcher.host,
          indexName: searcher.indexNames.base,
          esVersion: searcher.esVersion,
        }
      : {}

    return res.json(ApiResponse.success({ crowiVersion, searchInfo }))
  }

  actions.api.postSettings = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const form = req.form.settingForm

    if (req.form.isValid) {
      debug('form content', form)

      // mail setting ならここで validation
      if (form['mail:from']) {
        validateMailSetting(req, form, function(err, data) {
          debug('Error validate mail setting: ', err, data)
          if (err) {
            req.form.errors.push('SMTPを利用したテストメール送信に失敗しました。設定をみなおしてください。')
            return res.json(ApiResponse.error(req.form.errors.join('\n')))
          }
          return saveSetting(req, res, form)
        })
      }
      if (form['auth:disablePasswordAuth'] && !user.hasValidThirdPartyId()) {
        return res.json(ApiResponse.error('パスワードによるログインを禁止するには管理者が有効な外部サービスと連携している必要があります。'))
      }
      return saveSetting(req, res, form)
    } else {
      return res.json(ApiResponse.error(req.form.errors.join('\n')))
    }
  }

  actions.api.notificationAdd = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    var UpdatePost = crowi.model('UpdatePost')
    var pathPattern = req.body.pathPattern
    var channel = req.body.channel

    debug('notification.add', pathPattern, channel)
    UpdatePost.createUpdatePost(pathPattern, channel, user._id)
      .then(function(doc) {
        debug('Successfully save updatePost', doc)

        // fixme: うーん
        doc.creator = ((doc.creator as any) as UserDocument)._id.toString() as any
        return res.json(ApiResponse.success({ updatePost: doc }))
      })
      .catch(function(err) {
        debug('Failed to save updatePost', err)
        return res.json(ApiResponse.error())
      })
  }

  // app.post('/_api/admin/notifications.remove' , admin.api.notificationRemove);
  actions.api.notificationRemove = async function(req: Request, res: Response) {
    const UpdatePost = crowi.model('UpdatePost')
    const id = req.body.id

    try {
      await UpdatePost.findOneAndRemove({ _id: id })
      debug('Successfully remove updatePost')

      return res.json(ApiResponse.success({}))
    } catch (err) {
      debug('Failed to remove updatePost', err)
      return res.json(ApiResponse.error())
    }
  }

  // app.get('/_api/admin/users.search' , admin.api.userSearch);
  actions.api.usersSearch = function(req: Request, res: Response) {
    const User = crowi.model('User')
    const email = req.query.email

    User.findUsersByPartOfEmail(email, {})
      .then(users => {
        const result = {
          data: users,
        }
        return res.json(ApiResponse.success(result))
      })
      .catch(err => {
        return res.json(ApiResponse.error())
      })
  }

  function saveSetting(req, res, form) {
    Config.updateConfigByNamespace('crowi', form)
    return res.json(ApiResponse.success())
  }

  function validateMailSetting(req, form, callback) {
    const mailer = crowi.mailer
    const option: {
      host: string
      port: number
      auth?: any
      secure?: boolean
    } = {
      host: form['mail:smtpHost'],
      port: form['mail:smtpPort'],
    }
    if (form['mail:smtpUser'] && form['mail:smtpPassword']) {
      option.auth = {
        user: form['mail:smtpUser'],
        pass: form['mail:smtpPassword'],
      }
    }
    if (option.port === 465) {
      option.secure = true
    }

    var smtpClient = mailer.createSMTPClient(option)
    debug('mailer setup for validate SMTP setting', smtpClient)

    smtpClient.sendMail(
      {
        to: req.user.email,
        subject: 'Wiki管理設定のアップデートによるメール通知',
        text: 'このメールは、WikiのSMTP設定のアップデートにより送信されています。',
      },
      callback,
    )
  }

  actions.api.backlink = {}
  actions.api.backlink.buildBacklinks = function(req: Request, res: Response) {
    const Backlink = crowi.model('Backlink')
    // In background
    Backlink.createByAllPages()

    return res.json(ApiResponse.success({ message: 'Now re-building backlinks ... this takes a while.' }))
  }

  return actions
}
