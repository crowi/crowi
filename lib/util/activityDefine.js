module.exports = function() {
  'use strict'

  const MODELS = {
    PAGE: 'Page',
    COMMENT: 'Comment',
    MENTION: 'Mention',
  }

  const ACTIONS = {
    COMMENT: 'COMMENT',
    LIKE: 'LIKE',
    MENTION: 'MENTION',
  }

  const getSupportTargetModelNames = function() {
    return [MODELS.PAGE]
  }

  const getSupportEventModelNames = function() {
    return [MODELS.COMMENT, MODELS.MENTION]
  }

  const getSupportActionNames = function() {
    return Object.keys(ACTIONS)
  }

  const activityDefine = {
    MODELS,
    ACTIONS,

    getSupportTargetModelNames,
    getSupportEventModelNames,
    getSupportActionNames,
  }

  return activityDefine
}
