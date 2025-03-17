import form from 'express-form'
const { field } = form

export default form(field('settingForm[app:externalShare]'))
