import form from 'express-form'
const { field } = form

export default form(
  field('settingForm[github:clientId]')
    .trim()
    .is(/^[\d.a-z\-.]+$/),
  field('settingForm[github:clientSecret]')
    .trim()
    .is(/^[\da-zA-Z\-_]+$/),
  field('settingForm[github:organization]')
    .trim()
    .is(/^[\da-zA-Z\-_]+$/),
)
