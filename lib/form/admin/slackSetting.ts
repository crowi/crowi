import form from 'express-form'
const { field } = form

export default form(
  field('slackSetting[slack:clientId]', 'clientId')
    .is(/(\d+)\.(\d+)/)
    .required(),
  field('slackSetting[slack:clientSecret]', 'clientSecret')
    .required()
    .is(/([0-9a-f]+)/),
)
