import form from 'express-form'
const { field } = form

export default form(
  field('settingForm[mail:from]', 'メールFrom').trim(),
  field('settingForm[mail:smtpHost]', 'SMTPホスト').trim(),
  field('settingForm[mail:smtpPort]', 'SMTPポート')
    .trim()
    .toInt(),
  field('settingForm[mail:smtpUser]', 'SMTPユーザー').trim(),
  field('settingForm[mail:smtpPassword]', 'SMTPパスワード').trim(),
)
