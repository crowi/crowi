import form from 'express-form'
const { field } = form

export default form(field('settingForm[app:title]').required(), field('settingForm[app:confidential]'), field('settingForm[app:fileUpload]').toBooleanStrict())
