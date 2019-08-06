import form from 'express-form'
const { field } = form

export default form(
  field('mePassword.oldPassword'),
  field('mePassword.newPassword')
    .required()
    .is(/^[\x20-\x7F]{6,}$/),
  field('mePassword.newPasswordConfirm').required(),
)
