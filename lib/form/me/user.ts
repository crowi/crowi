import form from 'express-form'
const { field } = form

export default form(field('userForm.name').trim().required(), field('userForm.email').trim().isEmail().required(), field('userForm.lang').required())
