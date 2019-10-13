import form from 'express-form'
const { field } = form

export default form(
  field('settingForm[upload:aws:region]', 'リージョン')
    .trim()
    .is(/^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/, 'リージョンには、AWSリージョン名を入力してください。 例: ap-northeast-1'),
  field('settingForm[upload:aws:bucket]', 'バケット名').trim(),
  field('settingForm[upload:aws:accessKeyId]', 'Access Key Id')
    .trim()
    .is(/^[\da-zA-Z]+$/),
  field('settingForm[upload:aws:secretAccessKey]', 'Secret Access Key').trim(),
)
