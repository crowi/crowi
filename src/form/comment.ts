import form from 'express-form'
const { field } = form

export default form(
  field('commentForm.page_id').trim().required(),
  field('commentForm.revision_id').trim().required(),
  field('commentForm.comment').trim().required(),
  field('commentForm.comment_position').trim().toInt(),
)
