import form from 'express-form'
const { field } = form

export default form(field('inviteForm[emailList]', '招待メールアドレス').trim().required(), field('inviteForm[sendEmail]').trim())
