const ActivityDefine = require('../util/activityDefine')()

module.exports = function() {
  'use strict'

  const { MODELS, ACTIONS } = ActivityDefine

  const TARGET_TYPES = {
    TARGET: 'target',
    EVENT: 'event',
  }

  const ACTION_TARGET_TYPE_MAP = {
    [ACTIONS.COMMENT]: TARGET_TYPES.TARGET,
    [ACTIONS.LIKE]: TARGET_TYPES.TARGET,
    [ACTIONS.MENTION]: null,
  }

  const getSupportTargetModelNames = function() {
    return MODELS
  }

  const getTargetType = function(action) {
    return ACTION_TARGET_TYPE_MAP[action]
  }

  const watcherDefine = {
    TARGET_TYPES,
    ACTION_TARGET_TYPE_MAP,

    getSupportTargetModelNames,
    getTargetType,
  }

  return watcherDefine
}
