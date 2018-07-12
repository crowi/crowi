module.exports = function(crowi, app) {
  'use strict'

  var debug = require('debug')('crowi:routes:me')
  var fs = require('fs')
  var models = crowi.models
  var config = crowi.getConfig()
  var User = models.User
  //, pluginService = require('../service/plugin')
  var actions = {}
  var api = {}

  actions.api = api

  api.uploadPicture = function(req, res) {
    var fileUploader = require('../util/fileUploader')(crowi, app)
    // var storagePlugin = new pluginService('storage');
    // var storage = require('../service/storage').StorageService(config);

    var tmpFile = req.file || null
    if (!tmpFile) {
      return res.json({
        status: false,
        message: 'File type error.',
      })
    }

    var tmpPath = tmpFile.path
    var name = tmpFile.filename + tmpFile.originalname
    var ext = name.match(/(.*)(?:\.([^.]+$))/)[2]
    var filePath = User.createUserPictureFilePath(req.user, ext)
    var acceptableFileType = /image\/.+/

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
    var tmpFileStream = fs.createReadStream(tmpPath, {
      flags: 'r',
      encoding: null,
      fd: null,
      mode: '0666',
      autoClose: true,
    })

    fileUploader
      .uploadFile(filePath, tmpFile.mimetype, tmpFileStream, {})
      .then(function(data) {
        var imageUrl = fileUploader.generateUrl(filePath)
        req.user.updateImage(imageUrl, function(err, data) {
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

  actions.index = function(req, res) {
    var userForm = req.body.userForm
    var userData = req.user

    if (req.method == 'POST' && req.form.isValid) {
      var name = userForm.name
      var email = userForm.email
      var lang = userForm.lang

      if (!User.isEmailValid(email)) {
        req.form.errors.push("You can't update to that email address")
        return res.render('me/index', {})
      }

      User.findOne({ email: email }, (err, existingUserData) => {
        // If another user uses the same email, an error will occur.
        if (existingUserData && !existingUserData._id.equals(userData._id)) {
          debug('Email address was duplicated')
          req.form.errors.push('It can not be changed to that mail address')
          return res.render('me/index', {})
        }

        userData.update(name, email, lang, (err, userData) => {
          if (err) {
            Object.keys(err.errors).forEach(e => {
              req.form.errors.push(err.errors[e].message)
            })
            return res.render('me/index', {})
          }

          req.i18n.changeLanguage(lang)
          req.flash('successMessage', req.t('Updated'))
          return res.redirect('/me')
        })
      })
    } else {
      // method GET
      /// そのうちこのコードはいらなくなるはず
      if (!userData.isEmailSet()) {
        req.flash('warningMessage', 'メールアドレスが設定されている必要があります')
      }

      return res.render('me/index', {})
    }
  }

  actions.password = function(req, res) {
    var passwordForm = req.body.mePassword
    var userData = req.user

    // パスワードを設定する前に、emailが設定されている必要がある (schemaを途中で変更したため、最初の方の人は登録されていないかもしれないため)
    // そのうちこのコードはいらなくなるはず
    if (!userData.isEmailSet()) {
      return res.redirect('/me')
    }

    if (req.method == 'POST' && req.form.isValid) {
      var newPassword = passwordForm.newPassword
      var newPasswordConfirm = passwordForm.newPasswordConfirm
      var oldPassword = passwordForm.oldPassword

      if (userData.isPasswordSet() && !userData.isPasswordValid(oldPassword)) {
        req.form.errors.push('Wrong current password')
        return res.render('me/password', {})
      }

      // check password confirm
      if (newPassword != newPasswordConfirm) {
        req.form.errors.push('Failed to verify passwords')
      } else {
        userData.updatePassword(newPassword, function(err, userData) {
          if (err) {
            for (var e in err.errors) {
              if (err.errors.hasOwnProperty(e)) {
                req.form.errors.push(err.errors[e].message)
              }
            }
            return res.render('me/password', {})
          }

          req.flash('successMessage', 'Password updated')
          return res.redirect('/me/password')
        })
      }
    } else {
      // method GET
      return res.render('me/password', {})
    }
  }

  actions.apiToken = function(req, res) {
    var userData = req.user

    if (req.method == 'POST' && req.form.isValid) {
      userData
        .updateApiToken()
        .then(function(userData) {
          req.flash('successMessage', 'API Token updated')
          return res.redirect('/me/apiToken')
        })
        .catch(function(err) {
          // req.flash('successMessage',);
          req.form.errors.push('Failed to update API Token')
          return res.render('me/api_token', {})
        })
    } else {
      return res.render('me/api_token', {})
    }
  }

  actions.updates = function(req, res) {
    res.render('me/update', {})
  }

  actions.deletePicture = function(req, res) {
    // TODO: S3 からの削除
    req.user.deleteImage(function(err, data) {
      req.flash('successMessage', 'Deleted profile picture')
      res.redirect('/me')
    })
  }

  actions.authGoogle = function(req, res) {
    const googleAuth = require('../util/googleAuth')(config)
    const { user: userData } = req
    const toDisconnect = !!req.body.disconnectGoogle
    const toConnect = !!req.body.connectGoogle

    if (toDisconnect) {
      userData.deleteGoogleId(function(err, userData) {
        req.flash('successMessage', 'Disconnected from Google account')
        return res.redirect('/me')
      })
    } else if (toConnect) {
      googleAuth.createAuthUrl(req, function(err, redirectUrl) {
        if (err) {
          // TODO
        }
        req.session.google = { callbackAction: '/me/auth/google/callback' }
        return res.redirect(redirectUrl)
      })
    } else {
      return res.redirect('/me')
    }
  }

  actions.authGoogleCallback = function(req, res) {
    const googleAuth = require('../util/googleAuth')(config)
    const { user: userData } = req

    googleAuth.handleCallback(req, function(err, tokenInfo) {
      if (err) {
        req.flash('warningMessage.auth.google', err.message) // FIXME: show library error message directly
        return res.redirect('/me') // TODO Handling
      }

      const { user_id: googleId, email: googleEmail } = tokenInfo

      if (!User.isEmailValid(googleEmail)) {
        req.flash('warningMessage.auth.google', "You can't connect with this  Google's account")
        return res.redirect('/me')
      }

      User.findUserByGoogleId(googleId, function(err, googleUser) {
        if (!err && googleUser) {
          req.flash('warningMessage.auth.google', "This Google's account is connected by another user")
          return res.redirect('/me')
        } else {
          userData.updateGoogleId(googleId, function(err, userData) {
            if (err) {
              debug('Failed to updateGoogleId', err)
              req.flash('warningMessage.auth.google', 'Failed to connect Google Account')
              return res.redirect('/me')
            }

            // TODO if err
            req.flash('successMessage', 'Connected with Google')
            return res.redirect('/me')
          })
        }
      })
    })
  }

  actions.authGitHub = function(req, res, next) {
    const githubAuth = require('../util/githubAuth')(config)
    const { user: userData } = req
    const toDisconnect = !!req.body.disconnectGitHub
    const toConnect = !!req.body.connectGitHub

    if (toDisconnect) {
      userData.deleteGitHubId(function(err, userData) {
        req.flash('successMessage', 'Disconnected from GitHub account')

        return res.redirect('/me')
      })
    } else if (toConnect) {
      req.session.github = { callbackAction: '/me/auth/github/callback' }
      githubAuth.authenticate(req, res, next)
    } else {
      return res.redirect('/me')
    }
  }

  actions.authGitHubCallback = function(req, res, next) {
    const githubAuth = require('../util/githubAuth')(config)
    const { user: userData } = req

    githubAuth.handleCallback(req, res, next)(function(err, tokenInfo) {
      debug('err', err)
      if (err) {
        req.flash('warningMessage.auth.github', err.message)
        return res.redirect('/me') // TODO Handling
      }

      const { organizations: githubOrganizations, user_id: githubId, email: githubEmail } = tokenInfo

      if (!User.isEmailValid(githubEmail) || !User.isGitHubAccountValid(githubOrganizations)) {
        req.flash('warningMessage.auth.github', "You can't connect with this  GitHub's account")
        return res.redirect('/me')
      }

      User.findUserByGitHubId(githubId, function(err, githubUser) {
        if (!err && githubUser) {
          req.flash('warningMessage.auth.github', "This GitHub's account is connected by another user")
          return res.redirect('/me')
        } else {
          userData.updateGitHubId(githubId, function(err, userData) {
            if (err) {
              debug('Failed to updateGitHubId', err)
              req.flash('warningMessage.auth.github', 'Failed to connect GitHub Account')
              return res.redirect('/me')
            }

            // TODO if err
            req.flash('successMessage', 'Connected with GitHub')
            return res.redirect('/me')
          })
        }
      })
    })
  }

  return actions
}
