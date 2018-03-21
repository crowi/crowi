module.exports = function(crowi, app) {
  'use strict';

  var googleapis = require('googleapis')
    , debug = require('debug')('crowi:routes:login')
    , async    = require('async')
    , url = require('url')
    , config = crowi.getConfig()
    , mailer = crowi.getMailer()
    , Page = crowi.model('Page')
    , User = crowi.model('User')
    , Config = crowi.model('Config')
    , Revision = crowi.model('Revision')
    , actions = {};

  var clearSession = function(req) {
    delete req.session.googleAuthCode;
    delete req.session.googleId;
    delete req.session.googleEmail;
    delete req.session.googleName;
    delete req.session.googleImage;
    delete req.session.githubAuthCode;
    delete req.session.githubId;
    delete req.session.githubEmail;
    delete req.session.githubName;
    delete req.session.githubImage;
    delete req.session.socialId;
    delete req.session.socialEmail;
    delete req.session.socialName;
    delete req.session.socialImage;
  };

  var loginSuccess = function(req, res, userData) {
    req.user = req.session.user = userData;
    if (!userData.password) {
      return res.redirect('/me/password');
    }

    clearSession(req);

    var jumpTo = req.session.jumpTo;
    if (jumpTo) {
      req.session.jumpTo = null;
      return res.redirect(jumpTo);
    } else {
      return res.redirect('/');
    }
  };

  var loginFailure = function(req, res) {
    req.flash('warningMessage', 'Sign in failure.');
    return res.redirect('/login');
  };

  actions.googleCallback = function(req, res) {
    debug("Header", req.url, req.headers.referer);
    var nextAction = req.session.googleCallbackAction || '/login';
    debug('googleCallback.nextAction', nextAction);
    req.session.googleAuthCode = req.query.code || '';
    debug('google auth code', req.query.code);


    return res.redirect(nextAction);
  };

  actions.githubCallback = function(req, res) {
    debug("Header", req.url, req.headers.referer);
    var action = req.session.githubCallbackAction;
    var nextAction = action ? url.format({ pathname: action, query: req.query }) : '/login';
    debug('githubCallback.nextAction', nextAction);
    req.session.githubAuthCode = req.query.code || '';
    debug('github auth code', req.query.code);


    return res.redirect(nextAction);
  }

  actions.error = function(req, res) {
    var reason = req.params.reason
      , reasonMessage = ''
      ;

    if (reason === 'suspended') {
      reasonMessage = 'This account is suspended.';
    } else if (reason === 'registered') {
      reasonMessage = 'Wait for approved by administrators.';
    } else {
    }

    return res.render('login/error', {
      reason: reason,
      reasonMessage: reasonMessage
    });
  };

  actions.login = function(req, res) {
    debug("Header", req.url, req.headers.referer);
    var loginForm = req.body.loginForm;

    if (req.method == 'POST' && req.form.isValid) {
      var email = loginForm.email;
      var password = loginForm.password;

      User.findUserByEmailAndPassword(email, password, function(err, userData) {
        debug('on login findUserByEmailAndPassword', err, userData);
        if (userData) {
          loginSuccess(req, res, userData);
        } else {
          loginFailure(req, res);
        }
      });
    } else { // method GET
      if (req.form) {
        debug(req.form.errors);
      }
      return res.render('login', {
      });
    }
  };

  actions.loginGoogle = function(req, res) {
    debug("Header", req.url, req.headers.referer);
    var googleAuth = require('../util/googleAuth')(config);
    var code = req.session.googleAuthCode || null;

    debug("code", code);
    if (!code) {
      googleAuth.createAuthUrl(req, function(err, redirectUrl) {
        if (err) {
          // TODO
        }

        req.session.googleCallbackAction = '/login/google';
        return res.redirect(redirectUrl);
      });
    } else {
      googleAuth.handleCallback(req, function(err, tokenInfo) {
        debug('handleCallback', err, tokenInfo);
        if (err) {
          return loginFailure(req, res);
        }

        var googleId = tokenInfo.user_id;
        User.findUserByGoogleId(googleId, function(err, userData) {
          debug('findUserByGoogleId', err, userData);
          if (!userData) {
            clearSession(req);
            return loginFailure(req, res);
          }
          return loginSuccess(req, res, userData);
        });
      });
    }
  };

  actions.loginGitHub = function(req, res, next) {
    debug("Header", req.url, req.headers.referer);
    var githubAuth = require('../util/githubAuth')(config);
    var code = req.session.githubAuthCode || null;

    debug("code", code);
    if (!code) {
      req.session.githubCallbackAction = '/login/github';
      githubAuth.authenticate(req, res, next);
    } else {
      githubAuth.handleCallback(req, res, next)(function(err, tokenInfo) {
        debug('handleCallback', err, tokenInfo);
        if (err) {
          return loginFailure(req, res);
        }

        var githubId = tokenInfo.user_id;
        User.findUserByGitHubId(githubId, function(err, userData) {
          debug('findUserByGitHubId', err, userData);
          if (!userData) {
            clearSession(req);
            return loginFailure(req, res);
          }
          return loginSuccess(req, res, userData);
        });
      });
    }
  };

  actions.register = function(req, res, next) {
    debug("Header", req.url, req.headers.referer);
    var lang= req.lang || User.LANG_EN_US;

    // ログイン済みならさようなら
    if (req.user) {
      return res.redirect('/');
    }

    // config で closed ならさよなら
    if (config.crowi['security:registrationMode'] == Config.SECURITY_REGISTRATION_MODE_CLOSED) {
      return res.redirect('/');
    }

    if (req.method == 'POST' && req.form.isValid) {
      var registerForm = req.form.registerForm || {};

      var name = registerForm.name;
      var username = registerForm.username;
      var email = registerForm.email;
      var password = registerForm.password;
      var googleId = registerForm.googleId || null;
      var githubId = registerForm.githubId || null;
      var socialImage = registerForm.socialImage || null;

      debug("registerForm", registerForm)

      // email と username の unique チェックする
      User.isRegisterable(email, username, function (isRegisterable, errOn) {
        var isError = false;
        if (!User.isEmailValid(email)) {
          isError = true;
          req.flash('registerWarningMessage', 'This email address could not be used. (Make sure the allowed email address)');
        }
        if (!isRegisterable) {
          if (!errOn.username) {
            isError = true;
            req.flash('registerWarningMessage', 'This User ID is not available.');
          }
          if (!errOn.email) {
            isError = true;
            req.flash('registerWarningMessage', 'This email address is already registered.');
          }

        }
        if (isError) {
          debug('isError user register error', errOn);
          return res.redirect('/register');
        }

        User.createUserByEmailAndPassword(name, username, email, password, lang, function(err, userData) {
          if (err) {
            req.flash('registerWarningMessage', 'Failed to register.');
            return res.redirect('/register');
          } else {

            // 作成後、承認が必要なモードなら、管理者に通知する
            if (config.crowi['security:registrationMode'] === Config.SECURITY_REGISTRATION_MODE_RESTRICTED) {
              // TODO send mail
              User.findAdmins(function(err, admins) {
                async.each(
                  admins,
                  function(adminUser, next) {
                    mailer.send({
                        to: adminUser.email,
                        subject: '[' + config.crowi['app:title'] + ':admin] A New User Created and Waiting for Activation',
                        template: 'admin/userWaitingActivation.txt',
                        vars: {
                          createdUser: userData,
                          adminUser: adminUser,
                          url: config.crowi['app:url'],
                          appTitle: config.crowi['app:title'],
                        }
                      },
                      function (err, s) {
                        debug('completed to send email: ', err, s);
                        next();
                      }
                    );
                  },
                  function(err) {
                    debug('Sending invitation email completed.', err);
                  }
                );
              });
            }

            if (googleId || githubId) {
              if (googleId) {
                userData.updateGoogleId(googleId, function(err, userData) {
                  if (err) { // TODO
                  }
                  return loginSuccess(req, res, userData);
                });
              }
              if (githubId) {
                userData.updateGitHubId(githubId, function(err, userData) {
                  if (err) { // TODO
                  }
                  return loginSuccess(req, res, userData);
                });
              }

              if (socialImage) {
                var axios = require('axios');
                var fileUploader = require('../util/fileUploader')(crowi, app);

                axios.get(socialImage, {responseType: 'stream'})
                .then(function(response) {
                  var type = response.headers['content-type'];
                  var ext = type.replace('image/', '');
                  var filePath = User.createUserPictureFilePath(userData, ext);
                  var fileStream = response.data;
                  fileStream.length = parseInt(response.headers['content-length']);

                  fileUploader.uploadFile(filePath, type, fileStream, {})
                  .then(function(data) {
                    var imageUrl = fileUploader.generateUrl(filePath);
                    debug('user picture uploaded', imageUrl);
                    userData.updateImage(imageUrl, function(err, data) {
                      if (err) {
                        debug('Error on update user image', err);
                      }
                      // DONE
                    });
                  }).catch(function (err) { // ignore
                    debug('Upload error', err);
                  });
                }).catch(function() { // ignore
                });
              }
            } else {
              return loginSuccess(req, res, userData);
            }
          }
        });
      });
    } else { // method GET of form is not valid
      debug('session is', req.session);
      var isRegistering = true;

      var googleId = req.session.googleId || null;
      var githubId = req.session.githubId || null;
      var socialId = googleId || githubId;
      var socialEmail = req.session.googleEmail || req.session.githubEmail;
      var socialName = req.session.googleName || req.session.githubName;
      var socialImage = req.session.googleImage || req.session.githubImage;
      var issuerName = googleId ? "Google" : githubId ? "GitHub" : "";

      if (!User.isEmailValid(socialEmail)) {
        req.flash('registerWarningMessage', 'このメールアドレスのアカウントはコネクトできません。');
        return res.redirect('/login?register=1');
      }

      var locals = {
        isRegistering,
        googleId,
        githubId,
        socialId,
        socialEmail,
        socialName,
        socialImage,
        issuerName
      };

      return res.render('login', locals);
    }
  };

  actions.registerGoogle = function(req, res) {
    debug("Header", req.url, req.headers.referer);
    var googleAuth = require('../util/googleAuth')(config);
    var code = req.session.googleAuthCode || null;

    debug("code", code);
    if (!code) {
      googleAuth.createAuthUrl(req, function(err, redirectUrl) {
        if (err) {
          // TODO
        }

        req.session.googleCallbackAction = '/register/google';
        return res.redirect(redirectUrl);
      });
    } else {
      debug('register. if googleAuthCode', code);
      googleAuth.handleCallback(req, function(err, tokenInfo) {
        debug('tokenInfo on register GET', tokenInfo);
        clearSession(req);

        if (err) {
          req.flash('registerWarningMessage', 'Error on connectiong Google');
          return res.redirect('/login?register=1'); // TODO Handling
        }

        req.session.googleId = tokenInfo.user_id;
        req.session.googleEmail = tokenInfo.email;
        req.session.googleName = tokenInfo.name;
        req.session.googleImage = tokenInfo.picture;

        return res.redirect("/register");
      });
    }
  };

  actions.registerGitHub = function(req, res, next) {
    debug("Header", req.url, req.headers.referer);
    var githubAuth = require('../util/githubAuth')(config);
    var code = req.session.githubAuthCode || null;

    debug("code", code);
    if (!code) {
      req.session.githubCallbackAction = '/register/github';
      githubAuth.authenticate(req, res, next);
    } else {
      debug('register. if githubAuthCode', code);
      githubAuth.handleCallback(req, res, next)(function(err, tokenInfo) {
        debug('tokenInfo on register GET', err, tokenInfo);
        clearSession(req);

        if (err) {
          req.flash('registerWarningMessage', 'Error on connectiong GitHub');
          return res.redirect('/login?register=1'); // TODO Handling
        }

        req.session.githubId = tokenInfo.user_id;
        req.session.githubEmail = tokenInfo.email;
        req.session.githubName = tokenInfo.name;
        req.session.githubImage = tokenInfo.picture;

        return res.redirect("/register");
      });
    }
  }

  actions.invited = function(req, res) {
    if (!req.user) {
      return res.redirect('/login');
    }

    if (req.method == 'POST' && req.form.isValid) {
      var user = req.user;
      var invitedForm = req.form.invitedForm || {};
      var username = invitedForm.username;
      var name = invitedForm.name;
      var password = invitedForm.password;

      User.isRegisterableUsername(username, function(creatable) {
        if (creatable) {
          user.activateInvitedUser(username, name, password, function(err, data) {
            if (err) {
              req.flash('warningMessage', 'アクティベートに失敗しました。');
              return res.render('invited');
            } else {
              return res.redirect('/');
            }
          });
        } else {
          req.flash('warningMessage', '利用できないユーザーIDです。');
          debug('username', username);
          return res.render('invited');
        }
      });
    } else {
      return res.render('invited', {
      });
    }
  };

  actions.updateInvitedUser = function(req, res) {
    return res.redirect('/');
  };

  return actions;
};
