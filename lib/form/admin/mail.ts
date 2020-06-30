import form from 'express-form'
const { field } = form

export default form(
  field('settingForm[mail:from]', 'メールFrom').trim(),
  field('settingForm[mail:smtpHost]', 'SMTPホスト').trim(),
  field('settingForm[mail:smtpPort]', 'SMTPポート').trim().toInt(),
  field('settingForm[mail:smtpUser]', 'SMTPユーザー').trim(),
  field('settingForm[mail:smtpPassword]', 'SMTPパスワード').trim(),
  field('settingForm[mail:aws:region]', 'リージョン')
    .trim()
    .is(/^[a-z]+(-[a-z]+)?-[a-z]+-\d+$/, 'リージョンには、AWSリージョン名を入力してください。 例: ap-northeast-1'),
  field('settingForm[mail:aws:accessKeyId]', 'Access Key Id')
    .trim()
    .is(/^[\da-zA-Z]+$/),
  field('settingForm[mail:aws:secretAccessKey]', 'Secret Access Key').trim(),
)
