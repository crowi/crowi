'use strict'

var form = require('express-form')
var field = form.field

module.exports = form(
  field('commentForm.page_id')
    .trim()
    .required(),
  field('commentForm.revision_id')
    .trim()
    .required(),
  field('commentForm.comment')
    .trim()
    .required(),
  field('commentForm.comment_position')
    .trim()
    .toInt(),
)
