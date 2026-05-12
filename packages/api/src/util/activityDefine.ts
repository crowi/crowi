const MODEL_PAGE = 'Page';
const MODEL_COMMENT = 'Comment';

const ACTION_CREATE = 'CREATE'; // Not support yet
const ACTION_MODIFY = 'MODIFY'; // Not support yet
const ACTION_DELETE = 'DELETE'; // Not support yet
const ACTION_COMMENT = 'COMMENT';
const ACTION_LIKE = 'LIKE';
// RFC-0002 Phase 8: page-level mention of a user via `@username` in
// the body. Dispatched per mentioned-user (not fanned out to watchers)
// by `events/mention-dispatch.ts`.
const ACTION_MENTION = 'MENTION';

const getSupportTargetModelNames = () => {
  return [MODEL_PAGE];
};

const getSupportEventModelNames = () => {
  return [MODEL_COMMENT];
};

const getSupportActionNames = () => {
  return [
    // ACTION_CREATE,
    // ACTION_MODIFY,
    // ACTION_DELETE,
    ACTION_COMMENT,
    ACTION_LIKE,
    ACTION_MENTION,
  ];
};

const activityDefine = {
  MODEL_PAGE,
  MODEL_COMMENT,

  ACTION_CREATE, // Not support yet
  ACTION_MODIFY, // Not support yet
  ACTION_DELETE, // Not support yet
  ACTION_COMMENT,
  ACTION_LIKE,
  ACTION_MENTION,

  getSupportTargetModelNames,
  getSupportEventModelNames,
  getSupportActionNames,
};

export default activityDefine;
