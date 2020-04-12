import Crowi from 'server/crowi'
import { Request, Response } from 'express'

export default (crowi: Crowi) => {
  // var debug = Debug('crowi:routes:installer')
  const Config = crowi.model('Config')
  const User = crowi.model('User')
  const actions = {} as any

  actions.index = function(req: Request, res: Response) {
    return res.render('installer.html')
  }

  actions.createAdmin = function(req: Request, res: Response) {
    const registerForm = req.body.registerForm || {}
    const language = req.language || 'en'

    if (req.form.isValid) {
      const name = registerForm.name
      const username = registerForm.username
      const email = registerForm.email
      const password = registerForm.password

      User.createUserByEmailAndPassword(name, username, email, password, language, function(err, userData) {
        if (err) {
          req.form.errors.push('管理ユーザーの作成に失敗しました。' + err.message)
          // TODO
          return res.render('installer.html')
        }

        userData.makeAdmin(async function(err, userData) {
          if (err) return

          try {
            await Config.applicationInstall()

            // login処理
            req.user = req.session.user = userData
            req.flash('successMessage', 'Crowi のインストールが完了しました！はじめに、このページでこの Wiki の各種設定を確認してください。')
            return res.redirect('/admin/app')
          } catch (err) {
            // TODO
          }
        })
      })
    } else {
      return res.render('installer.html')
    }
  }

  return actions
}
