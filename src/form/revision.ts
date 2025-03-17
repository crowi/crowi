import form from 'express-form'
const { field } = form

export default form(
  field('pageForm.path').required(),
  field('pageForm.body')
    .required()
    .custom(function (value) {
      return value.replace(/\r/g, '\n')
    }),
  field('pageForm.currentRevision'),
  field('pageForm.grant').toInt().required(),
  field('pageForm.notify'),
)
