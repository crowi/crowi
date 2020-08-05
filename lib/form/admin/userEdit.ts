import form from 'express-form'
const { field } = form

export default form(field('userEditForm[name]').trim().required(), field('userEditForm[emailToBeChanged]').trim().required())
