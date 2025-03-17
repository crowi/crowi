import form from 'express-form'
const { field } = form

export default form(field('settingForm[auth:requireThirdPartyAuth]').toBoolean(), field('settingForm[auth:disablePasswordAuth]').toBoolean())
