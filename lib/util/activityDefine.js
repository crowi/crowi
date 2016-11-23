module.exports = function() {
  'use strict';

  const MODEL_PAGE    = 'Page';
  const MODEL_COMMENT = 'Comment';  // Not support yet

  const ACTION_CREATE  = 'CREATE';  // Not support yet
  const ACTION_MODIFY  = 'MODIFY';  // Not support yet
  const ACTION_DELETE  = 'DELETE';  // Not support yet
  const ACTION_COMMENT = 'COMMENT';
  const ACTION_LIKE    = 'LIKE';    // Not support yet

  const getSupportModelNames = function() {
    return [
      MODEL_PAGE,
      //MODEL_COMMENT,
    ];
  };

  const getSupportActionNames = function() {
    return [
      // ACTION_CREATE,
      // ACTION_MODIFY,
      // ACTION_DELETE,
      ACTION_COMMENT,
      ACTION_LIKE,
    ];
  };

  const activityDefine = {
    MODEL_PAGE:    'Page',
    MODEL_COMMENT: 'Comment',  // Not support yet

    ACTION_CREATE:  'CREATE',  // Not support yet
    ACTION_MODIFY:  'MODIFY',  // Not support yet
    ACTION_DELETE:  'DELETE',  // Not support yet
    ACTION_COMMENT: 'COMMENT',
    ACTION_LIKE:    'LIKE',    // Not support yet

    getSupportModelNames: getSupportModelNames,
    getSupportActionNames: getSupportActionNames,
  };

  return activityDefine;
};
