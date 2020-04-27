import { Express, Request, Response, NextFunction } from 'express'
import Crowi from 'server/crowi'
import Debug from 'debug'
import async from 'async'
import url from 'url'
import { getContinueUrl } from '../utils/url'
import auth from '../utils/auth'
import GoogleAuth from '../utils/googleAuth'
import GitHubAuth from '../utils/githubAuth'
import axios from 'axios'
import FileUploader from '../utils/fileUploader'

export default (crowi: Crowi, app: Express) => {
  const debug = Debug('crowi:routes:login')
  const config = crowi.getConfig()
  const mailer = crowi.getMailer()
  const User = crowi.model('User')
  const Config = crowi.model('Config')
  const actions = {} as any
  const isLoggedIn = auth.isLoggedIn

  const getSocialSession = function(session) {
    const { google = {}, github = {} } = session
    const { id: googleId } = google
    const { id: githubId } = github
    const socialId = googleId || githubId
    const socialEmail = google.email || github.email
    const socialName = google.name || github.name
    const socialImage = google.image || github.image
    const issuerName = googleId ? 'Google' : githubId ? 'GitHub' : ''

    return { googleId, githubId, socialId, socialEmail, socialName, socialImage, issuerName }
  }

  const clearSession = function(req) {
    req.session.google = {}
    req.session.github = {}
    req.session.social = {}
  }

  const loginSuccess = async function(req: Request, res: Response, userData) {
    userData = await userData.populateSecrets()
    req.user = req.session.user = userData
    if (!userData.password) {
      return res.redirect('/me/password')
    }

    clearSession(req)

    return res.redirect(getContinueUrl(req))
  }

  const loginFailure = function(req: Request, res: Response) {
    req.session.auth = {}
    req.flash('warningMessage', 'Sign in failure.')

    const continueUrl = getContinueUrl(req)
    const query = continueUrl === '/' ? '' : `?continue=${continueUrl}`
    const redirectUrl = `/login${query}`
    return res.redirect(redirectUrl)
  }

  const connect = async function(req, userData) {
    const { googleId, githubId } = getSocialSession(req.session)

    try {
      if (googleId) {
        await userData.updateGoogleId(googleId)
      } else if (githubId) {
        await userData.updateGitHubId(githubId)
      }
    } catch (err) {
      debug('Failed to connect', err)
    }
  }

  actions.googleCallback = function(req: Request, res: Response) {
    debug('Header', req.url, req.headers.referer)
    const { query } = req
    const { code = '', state } = query
    const { google = {} } = req.session
    const { callbackAction: action } = google
    const nextAction = action ? url.format({ pathname: action, query: { continue: state } }) : '/login'
    debug('googleCallback.nextAction', nextAction)
    req.session.google = { authCode: code }
    debug('google auth code', code)

    return res.redirect(nextAction)
  }

  actions.githubCallback = function(req: Request, res: Response) {
    debug('Header', req.url, req.headers.referer)
    const { query } = req
    const { code = '' } = query
    const { github = {} } = req.session
    const { callbackAction: action } = github
    const nextAction = action ? url.format({ pathname: action, query }) : '/login'
    debug('githubCallback.nextAction', nextAction)
    req.session.github = { authCode: code }
    debug('github auth code', code)

    return res.redirect(nextAction)
  }

  actions.error = function(req: Request, res: Response) {
    const reason = req.params.reason
    let reasonMessage = ''

    if (reason === 'suspended') {
      reasonMessage = 'This account is suspended.'
    } else if (reason === 'registered') {
      reasonMessage = 'Wait for approved by administrators.'
    }

    return res.render('login/error.html', {
      reason: reason,
      reasonMessage: reasonMessage,
    })
  }

  actions.login = async function(req: Request, res: Response) {
    debug('Header', req.url, req.headers.referer)
    const { loginForm } = req.body

    if (req.method == 'POST' && req.form.isValid) {
      let { email } = loginForm
      const { password } = loginForm
      const { toConnect } = req.body
      const { socialEmail } = getSocialSession(req.session)

      if (!toConnect && config.crowi['auth:disablePasswordAuth']) {
        return loginFailure(req, res)
      }

      email = toConnect ? socialEmail : email
      const userData = await User.findUserByEmailAndPassword(email, password).catch(err => {
        debug('on login findUserByEmailAndPassword', err)
      })

      if (userData) {
        if (toConnect) {
          await connect(req, userData)
        }
        return loginSuccess(req, res, userData)
      }

      return loginFailure(req, res)
    } else {
      const continueUrl = getContinueUrl(req)

      if (isLoggedIn(crowi, req)) {
        return res.redirect('/')
      }

      // method GET
      if (req.form) {
        debug(req.form.errors)
      }

      const socialSession = getSocialSession(req.session)
      const { socialId, socialEmail } = socialSession
      const targetUser = socialEmail
        ? await User.findUserByEmail(socialEmail).catch(err => {
            debug('Failed to findUserByEmail', err)
          })
        : null
      const toConnect = !!targetUser

      if (socialId) {
        if (toConnect) {
          const locals = { toConnect, targetUser, ...socialSession }

          return res.render('login.html', locals)
        }

        return res.redirect('/register')
      }

      return res.render('login.html', { continueUrl })
    }
  }

  actions.loginGoogle = function(req: Request, res: Response) {
    debug('Header', req.url, req.headers.referer)
    const googleAuth = GoogleAuth(config)
    const { google = {} } = req.session
    const { authCode: code } = google

    debug('code', code)
    if (!code) {
      googleAuth.createAuthUrl(req, function(err, redirectUrl) {
        if (err) {
          // TODO
        }

        req.session.google = { callbackAction: '/login/google' }
        return res.redirect(redirectUrl)
      })
    } else {
      googleAuth.handleCallback(req, async (err, tokenInfo) => {
        debug('handleCallback', err, tokenInfo)
        if (err) {
          return loginFailure(req, res)
        }

        const { user_id: id, email, name, picture: image } = tokenInfo

        const userData = await User.findUserByGoogleId(id).catch(err => {
          debug('findUserByGoogleId', err)
        })
        if (userData) {
          return loginSuccess(req, res, userData)
        }
        clearSession(req)
        req.session.google = { id, email, name, image }
        return res.redirect('/login')
      })
    }
  }

  actions.loginGitHub = function(req: Request, res: Response, next: NextFunction) {
    debug('Header', req.url, req.headers.referer)
    const githubAuth = GitHubAuth(config)
    const { github = {} } = req.session
    const { authCode: code } = github

    debug('code', code)
    if (!code) {
      req.session.github = { callbackAction: '/login/github' }
      githubAuth.authenticate(req, res, next)
    } else {
      githubAuth.handleCallback(
        req,
        res,
        next,
      )(async (err, tokenInfo) => {
        debug('handleCallback', err, tokenInfo)
        if (err) {
          return loginFailure(req, res)
        }

        const { organizations, user_id: id, email, name, picture: image } = tokenInfo

        if (organizations && !User.isGitHubAccountValid(organizations)) {
          clearSession(req)
          return loginFailure(req, res)
        }

        const userData = await User.findUserByGitHubId(id).catch(err => {
          debug('findUserByGitHubId', err)
        })
        if (userData) {
          return loginSuccess(req, res, userData)
        }

        clearSession(req)
        req.session.github = { organizations, id, email, name, image }
        return res.redirect('/login')
      })
    }
  }

  actions.register = async function(req: Request, res: Response) {
    debug('Header', req.url, req.headers.referer)
    // FIXME: lang
    const { lang = User.LANG_EN_US } = req as any

    // ログイン済みならさようなら
    if (req.user) {
      return res.redirect('/')
    }

    // config で closed ならさよなら
    if (config.crowi['security:registrationMode'] == Config.SECURITY_REGISTRATION_MODE_CLOSED) {
      return res.redirect('/')
    }

    if (req.method == 'POST' && req.form.isValid) {
      const { t } = req
      const { registerForm = {} } = req.form
      const { name = null, username = null, email = null, password = null, googleId = null, githubId = null, socialImage = null } = registerForm

      debug('registerForm', registerForm)

      // email と username の unique チェックする
      User.isRegisterable(email, username, function(isRegisterable, errOn) {
        const registerFailure = message => {
          req.flash('registerWarningMessage', message)
          debug('isError user register error', errOn)
          return res.redirect('/register')
        }

        if (!User.isEmailValid(email)) {
          return registerFailure('This email address could not be used. (Make sure the allowed email address)')
        }
        if (!isRegisterable) {
          if (!errOn.username) {
            return registerFailure(t('page_register.error.unavailable_user_id'))
          }
          if (!errOn.email) {
            return registerFailure(t('page_register.error.already_registered_email'))
          }
        }
        if (config.crowi['auth:disablePasswordAuth'] && !googleId && !githubId) {
          return registerFailure(t('page_register.error.unavailable_password_auth'))
        }

        User.createUserByEmailAndPassword(name, username, email, password, lang, async function(err, userData) {
          if (err) {
            req.flash('registerWarningMessage', 'Failed to register.')
            return res.redirect('/register')
          } else {
            // 作成後、承認が必要なモードなら、管理者に通知する
            if (config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_RESTRICTED) {
              // TODO send mail
              User.findAdmins(function(err, admins) {
                async.each(
                  admins,
                  function(adminUser, next) {
                    mailer.send(
                      {
                        to: adminUser.email,
                        subject: '[' + config.crowi['app:title'] + ':admin] A New User Created and Waiting for Activation',
                        template: 'admin/userWaitingActivation.txt',
                        vars: {
                          createdUser: userData,
                          adminUser: adminUser,
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
              })
            }

            // there are no googleId nor githubId, exit
            if (!googleId && !githubId) {
              return loginSuccess(req, res, userData)
            }

            // else, updating googleId/githubId and upload socialImage

            if (googleId) {
              try {
                userData = await userData.updateGoogleId(googleId)
              } catch (err) {
                // TODO
              }
            }
            if (githubId) {
              try {
                userData = await userData.updateGitHubId(githubId)
              } catch (err) {
                // TODO
              }
            }

            debug('socialImage?:', socialImage)
            if (socialImage) {
              const fileUploader = FileUploader(crowi)

              axios
                .get(socialImage, { responseType: 'stream' })
                .then(function(response) {
                  const type = response.headers['content-type']
                  const ext = type.replace('image/', '')
                  const filePath = User.createUserPictureFilePath(userData, ext)
                  const { data: fileStream } = response
                  fileStream.length = parseInt(response.headers['content-length'])

                  debug('Uploading user socialImage:', filePath, type)
                  fileUploader
                    .uploadFile(filePath, type, fileStream, {})
                    .then(function(data) {
                      const imageUrl = fileUploader.generateUrl(filePath)
                      debug('user picture uploaded', imageUrl)
                      userData.updateImage(imageUrl, function(err, data) {
                        if (err) {
                          debug('Error on update user image', err)
                        }
                        // DONE
                      })
                    })
                    .catch(function(err) {
                      // ignore
                      debug('Upload error', err)
                    })
                })
                .catch(function() {
                  // ignore
                })
            }

            return loginSuccess(req, res, userData)
          }
        })
      })
    } else {
      // method GET of form is not valid
      debug('session is', req.session)

      const isDisabledPasswordAuth = !!config.crowi['auth:disablePasswordAuth']

      const socialSession = getSocialSession(req.session)
      const { socialEmail } = socialSession
      const { github = {} } = req.session

      const registerFailure = message => {
        const isRegistering = isDisabledPasswordAuth
        const type = isRegistering ? 'warningMessage' : 'registerWarningMessage'
        req.flash(type, message)
        return res.render('login.html', { isRegistering })
      }

      if (!User.isEmailValid(socialEmail)) {
        return registerFailure('This email address could not be used. (Make sure the allowed email address)')
      }

      if (github.organizations && !User.isGitHubAccountValid(github.organizations)) {
        return registerFailure('This account could not be used. (Make sure whether you belong to allowed GitHub Organization)')
      }

      const isRegistering = true
      const targetUser = socialEmail
        ? await User.findUserByEmail(socialEmail).catch(err => {
            debug('Failed to findUserByEmail', err)
          })
        : null
      const toConnect = !!targetUser
      const locals = { isRegistering, toConnect, targetUser, ...socialSession }

      return res.render('register.html', locals)
    }
  }

  actions.invited = function(req: Request, res: Response) {
    if (!req.user) {
      return res.redirect('/login')
    }

    if (req.method == 'POST' && req.form.isValid) {
      const user = req.user
      const invitedForm = req.form.invitedForm || {}
      const username = invitedForm.username
      const name = invitedForm.name
      const password = invitedForm.password

      User.isRegisterableUsername(username, function(creatable) {
        if (creatable) {
          user.activateInvitedUser(username, name, password, function(err, data) {
            if (err) {
              req.flash('warningMessage', 'アクティベートに失敗しました。')
              return res.render('invited.html')
            } else {
              return res.redirect('/')
            }
          })
        } else {
          req.flash('warningMessage', '利用できないユーザーIDです。')
          debug('username', username)
          return res.render('invited.html')
        }
      })
    } else {
      return res.render('invited.html', {})
    }
  }

  actions.updateInvitedUser = function(req: Request, res: Response) {
    return res.redirect('/')
  }

  return actions
}
