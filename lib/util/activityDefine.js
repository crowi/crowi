module.exports = function() {
  'use strict'

  const MODEL_PAGE = 'Page'
  const MODEL_COMMENT = 'Comment'
  const MODEL_MENTION = 'Mention'

  const ACTION_CREATE = 'CREATE' // Not support yet
  const ACTION_MODIFY = 'MODIFY' // Not support yet
  const ACTION_DELETE = 'DELETE' // Not support yet
  const ACTION_COMMENT = 'COMMENT'
  const ACTION_LIKE = 'LIKE'
  const ACTION_MENTION = 'MENTION'

  const getSupportTargetModelNames = function() {
    return [MODEL_PAGE]
  }

  const getSupportEventModelNames = function() {
    return [MODEL_COMMENT, MODEL_MENTION]
  }

  const getSupportActionNames = function() {
    return [
      // ACTION_CREATE,
      // ACTION_MODIFY,
      // ACTION_DELETE,
      ACTION_COMMENT,
      ACTION_LIKE,
      ACTION_MENTION,
    ]
  }

  const activityDefine = {
    MODEL_PAGE,
    MODEL_COMMENT,
    MODEL_MENTION,

    ACTION_CREATE, // Not support yet
    ACTION_MODIFY, // Not support yet
    ACTION_DELETE, // Not support yet
    ACTION_COMMENT,
    ACTION_LIKE,
    ACTION_MENTION,

    getSupportTargetModelNames,
    getSupportEventModelNames,
    getSupportActionNames,
  }

  return activityDefine
}
