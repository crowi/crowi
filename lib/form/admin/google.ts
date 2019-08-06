import form from 'express-form'
const { field } = form

export default form(
  field('settingForm[google:clientId]')
    .trim()
    .is(/^[\d.a-z\-.]+$/),
  field('settingForm[google:clientSecret]')
    .trim()
    .is(/^[\da-zA-Z\-_]+$/),
)
