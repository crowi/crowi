import { Express, Request, Response, NextFunction } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import fs from 'fs'
import FileUploader from '../utils/fileUploader'
import GoogleAuth from '../utils/googleAuth'
import GitHubAuth from '../utils/githubAuth'
import { UserDocument } from 'server/models/user'

export default (crowi: Crowi, app: Express) => {
  const debug = Debug('crowi:routes:me')
  const config = crowi.getConfig()
  const User = crowi.model('User')
  const actions = {} as any
  const api = {} as any

  actions.api = api

  api.uploadPicture = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const fileUploader = FileUploader(crowi)
    // var storagePlugin = new pluginService('storage');
    // var storage = require('../service/storage').StorageService(config);

    const tmpFile = req.file || null
    if (!tmpFile) {
      return res.json({
        status: false,
        message: 'File type error.',
      })
    }

    const tmpPath = tmpFile.path
    const name = tmpFile.filename + tmpFile.originalname
    const ext = name.match(/(.*)(?:\.([^.]+$))/)?.[2] || ''
    const filePath = User.createUserPictureFilePath(user, ext)
    const acceptableFileType = /image\/.+/

    if (!tmpFile.mimetype.match(acceptableFileType)) {
      return res.json({
        status: false,
        message: 'File type error. Only image files is allowed to set as user picture.',
      })
    }

    // debug('tmpFile Is', tmpFile, tmpFile.constructor, tmpFile.prototype);
    // var imageUrl = storage.writeSync(storage.tofs(tmpFile), filePath, {mime: tmpFile.mimetype});
    // return return res.json({
    //  'status': true,
    //  'url': imageUrl,
    //  'message': '',
    // });
    const tmpFileStream = fs.createReadStream(tmpPath, {
      flags: 'r',
      mode: 666,
      autoClose: true,
    })

    fileUploader
      .uploadFile(filePath, tmpFile.mimetype, tmpFileStream, {})
      .then(function(data) {
        const imageUrl = fileUploader.generateUrl(filePath)
        user.updateImage(imageUrl, function(err, data) {
          fs.unlink(tmpPath, function(err) {
            // エラー自体は無視
            if (err) {
              debug('Error while deleting tmp file.', err)
            }

            return res.json({
              status: true,
              url: imageUrl,
              message: '',
            })
          })
        })
      })
      .catch(function(err) {
        debug('Uploading error', err)

        return res.json({
          status: false,
          message: 'Error while uploading to ',
        })
      })
  }

  actions.index = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const { userForm } = req.body

    if (req.method == 'POST' && req.form.isValid) {
      const { name, email, lang } = userForm

      if (!User.isEmailValid(email)) {
        req.form.errors.push("You can't update to that email address")
        return res.render('me/index.html', {})
      }

      User.findOne({ email }, async (err, existingUserData) => {
        // If another user uses the same email, an error will occur.
        if (existingUserData && !existingUserData._id.equals(user._id)) {
          debug('Email address was duplicated')
          req.form.errors.push('It can not be changed to that mail address')
          return res.render('me/index.html', {})
        }

        try {
          await user.update({ name, email, lang })
        } catch (err) {
          Object.keys(err.errors).forEach(e => {
            req.form.errors.push(err.errors[e].message)
          })
          return res.render('me/index.html', {})
        }

        req.i18n.changeLanguage(lang)
        req.flash('successMessage', req.t('Updated'))
        return res.redirect('/me')
      })
    } else {
      // method GET
      /// そのうちこのコードはいらなくなるはず
      if (!user.isEmailSet()) {
        req.flash('warningMessage', 'メールアドレスが設定されている必要があります')
      }

      return res.render('me/index.html', {})
    }
  }

  actions.password = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const { mePassword: passwordForm } = req.body

    // パスワードを設定する前に、emailが設定されている必要がある (schemaを途中で変更したため、最初の方の人は登録されていないかもしれないため)
    // そのうちこのコードはいらなくなるはず
    if (!user.isEmailSet()) {
      return res.redirect('/me')
    }

    if (req.method == 'POST' && req.form.isValid) {
      const newPassword = passwordForm.newPassword
      const newPasswordConfirm = passwordForm.newPasswordConfirm
      const oldPassword = passwordForm.oldPassword

      if (user.isPasswordSet() && !user.isPasswordValid(oldPassword)) {
        req.form.errors.push('Wrong current password')
        return res.render('me/password.html', {})
      }

      // check password confirm
      if (newPassword != newPasswordConfirm) {
        req.form.errors.push('Failed to verify passwords')
      } else {
        user.updatePassword(newPassword, function(err, user) {
          if (err) {
            for (const [key, e] of (err as any).errors) {
              req.form.errors.push(e.message)
            }
            return res.render('me/password.html', {})
          }

          req.flash('successMessage', 'Password updated')
          return res.redirect('/me/password')
        })
      }
    } else {
      // method GET
      return res.render('me/password.html', {})
    }
  }

  actions.apiToken = function(req: Request, res: Response) {
    const user = req.user as UserDocument

    if (req.method == 'POST' && req.form.isValid) {
      user
        .updateApiToken()
        .then(function(userData) {
          req.flash('successMessage', 'API Token updated')
          return res.redirect('/me/apiToken')
        })
        .catch(function(err) {
          // req.flash('successMessage',);
          req.form.errors.push('Failed to update API Token')
          return res.render('me/api_token.html', {})
        })
    } else {
      return res.render('me/api_token.html', {})
    }
  }

  actions.notifications = function(req: Request, res: Response) {
    const renderVars = {}

    return res.render('me/notifications.html', renderVars)
  }

  actions.updates = function(req: Request, res: Response) {
    res.render('me/update.html', {})
  }

  actions.deletePicture = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    // TODO: S3 からの削除
    user.deleteImage(function(err, data) {
      req.flash('successMessage', 'Deleted profile picture')
      res.redirect('/me')
    })
  }

  actions.authThirdParty = function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const { continue: continueUrl = '/' } = req.query

    if (!config.crowi['auth:requireThirdPartyAuth'] || user.hasValidThirdPartyId()) {
      req.session.callback = null
      return res.redirect(continueUrl)
    }
    req.session.callback = '/me/auth/third-party'
    return res.render('me/auth/third-party.html')
  }

  actions.authGoogle = async function(req: Request, res: Response) {
    const googleAuth = GoogleAuth(config)
    const user = req.user as UserDocument
    const { t } = req
    const toDisconnect = !!req.body.disconnectGoogle
    const toConnect = !!req.body.connectGoogle
    const callback = req.session.callback || '/me'

    if (toDisconnect) {
      if (user.canDisconnectThirdPartyId()) {
        await user.deleteGoogleId()
        try {
          req.flash('successMessage', 'Disconnected from Google account')
        } catch (err) {
          req.flash('warningMessage.auth.google', 'Failed to disconnect Google Account')
        }
        return res.redirect(callback)
      }
      req.flash('warningMessage.auth.google', t('page_me.can_not_disconnect'))
      return res.redirect(callback)
    } else if (toConnect) {
      googleAuth.createAuthUrl(req, function(err, redirectUrl) {
        if (err) {
          // TODO
        }
        req.session.google = { callbackAction: '/me/auth/google/callback' }
        return res.redirect(redirectUrl)
      })
    } else {
      return res.redirect(callback)
    }
  }

  actions.authGoogleCallback = function(req: Request, res: Response) {
    const googleAuth = GoogleAuth(config)
    const user = req.user as UserDocument
    const callback = req.session.callback || '/me'

    googleAuth.handleCallback(req, async function(err, tokenInfo) {
      if (err) {
        req.flash('warningMessage.auth.google', err.message) // FIXME: show library error message directly
        return res.redirect(callback) // TODO Handling
      }

      const { user_id: googleId, email: googleEmail } = tokenInfo

      if (!User.isEmailValid(googleEmail)) {
        req.flash('warningMessage.auth.google', "You can't connect with this  Google's account")
        return res.redirect(callback)
      }

      const googleUser = await User.findUserByGoogleId(googleId).catch(err => {
        debug('Failed to findUserByGoogleId', err)
      })
      if (googleUser) {
        req.flash('warningMessage.auth.google', "This Google's account is connected by another user")
        return res.redirect(callback)
      }

      try {
        await user.updateGoogleId(googleId)
        req.flash('successMessage', 'Connected with Google')
      } catch (err) {
        debug('Failed to updateGoogleId', err)
        req.flash('warningMessage.auth.google', 'Failed to connect Google Account')
      }

      return res.redirect(callback)
    })
  }

  actions.authGitHub = async function(req: Request, res: Response, next: NextFunction) {
    const githubAuth = GitHubAuth(config)
    const user = req.user as UserDocument
    const { t } = req
    const toDisconnect = !!req.body.disconnectGitHub
    const toConnect = !!req.body.connectGitHub
    const callback = req.session.callback || '/me'

    if (toDisconnect) {
      if (user.canDisconnectThirdPartyId()) {
        await user.deleteGitHubId()
        try {
          req.flash('successMessage', 'Disconnected from GitHub account')
        } catch (err) {
          req.flash('warningMessage.auth.github', 'Failed to disconnect GitHub Account')
        }
        return res.redirect(callback)
      }
      req.flash('warningMessage.auth.github', t('page_me.can_not_disconnect'))
      return res.redirect(callback)
    } else if (toConnect) {
      req.session.github = { callbackAction: '/me/auth/github/callback' }
      githubAuth.authenticate(req, res, next)
    } else {
      return res.redirect(callback)
    }
  }

  actions.authGitHubCallback = function(req: Request, res: Response, next) {
    const githubAuth = GitHubAuth(config)
    const user = req.user as UserDocument
    const callback = req.session.callback || '/me'

    githubAuth.handleCallback(
      req,
      res,
      next,
    )(async function(err, tokenInfo) {
      debug('err', err)
      if (err) {
        req.flash('warningMessage.auth.github', err.message)
        return res.redirect(callback) // TODO Handling
      }

      const { organizations: githubOrganizations, user_id: githubId, email: githubEmail } = tokenInfo

      if (!User.isEmailValid(githubEmail) || !User.isGitHubAccountValid(githubOrganizations)) {
        req.flash('warningMessage.auth.github', "You can't connect with this  GitHub's account")
        return res.redirect(callback)
      }

      const githubUser = await User.findUserByGitHubId(githubId).catch(err => {
        debug('Failed to findUserByGitHubId', err)
      })
      if (githubUser) {
        req.flash('warningMessage.auth.github', "This GitHub's account is connected by another user")
        return res.redirect(callback)
      }

      try {
        await user.updateGitHubId(githubId)
        req.flash('successMessage', 'Connected with GitHub')
      } catch (err) {
        debug('Failed to updateGitHubId', err)
        req.flash('warningMessage.auth.github', 'Failed to connect GitHub Account')
      }

      return res.redirect(callback)
    })
  }

  return actions
}
