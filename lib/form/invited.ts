import form from 'express-form'
const { field } = form

export default form(
  field('invitedForm.username')
    .required()
    .is(/^[\da-zA-Z\-_]+$/),
  field('invitedForm.name').required(),
  field('invitedForm.password')
    .required()
    .is(/^[\x20-\x7F]{6,}$/),
)
