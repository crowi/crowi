const MODEL_PAGE = 'Page';
const MODEL_COMMENT = 'Comment';

const ACTION_CREATE = 'CREATE'; // Not support yet
const ACTION_MODIFY = 'MODIFY'; // Not support yet
const ACTION_DELETE = 'DELETE'; // Not support yet
const ACTION_COMMENT = 'COMMENT';
const ACTION_LIKE = 'LIKE';
// feature-page-update-notification: fan-out to watchers when a page body
// gets a new revision. Named to match the page event ('update'), the
// contract NotificationAction enum ('UPDATE') and the i18n key
// (`notifications.action_update`) end-to-end. The reserved ACTION_MODIFY
// placeholder above is left untouched.
const ACTION_UPDATE = 'UPDATE';
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
    ACTION_UPDATE,
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
  ACTION_UPDATE,

  getSupportTargetModelNames,
  getSupportEventModelNames,
  getSupportActionNames,
};

export default activityDefine;
