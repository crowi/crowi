import form from 'express-form'
const { field } = form

export default form(
  field('loginForm.email').required(),
  field('loginForm.password')
    .required()
    .is(/^[\x20-\x7F]{6,}$/),
)
