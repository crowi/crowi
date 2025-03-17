import login from './login'
import register from './register'
import invited from './invited'
import revision from './revision'
import comment from './comment'
import user from './me/user'
import password from './me/password'
import apiToken from './me/apiToken'
import app from './admin/app'
import sec from './admin/sec'
import auth from './admin/auth'
import mail from './admin/mail'
import aws from './admin/aws'
import google from './admin/google'
import github from './admin/github'
import userInvite from './admin/userInvite'
import userEdit from './admin/userEdit'
import slackSetting from './admin/slackSetting'
import share from './admin/share'

export default {
  login,
  register,
  invited,
  revision,
  comment,
  me: {
    user,
    password,
    apiToken,
  },
  admin: {
    app,
    sec,
    auth,
    mail,
    aws,
    google,
    github,
    userInvite,
    userEdit,
    slackSetting,
    share,
  },
}
