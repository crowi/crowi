import form from 'express-form'
const { field } = form

export default form(field('apiTokenForm.confirm').required())
