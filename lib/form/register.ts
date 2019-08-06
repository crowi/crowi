import form from 'express-form'
const { field } = form

export default form(
  field('registerForm.username')
    .required()
    .is(/^[\da-zA-Z\-_.]+$/),
  field('registerForm.name').required(),
  field('registerForm.email').required(),
  field('registerForm.password')
    .required()
    .is(/^[\x20-\x7F]{6,}$/),
  field('registerForm.googleId'),
  field('registerForm.githubId'),
  field('registerForm.socialImage'),
)
