import Activity from './activity';
import Attachment from './attachment';
import Backlink from './backlink';
import Bookmark from './bookmark';
import Comment from './comment';
// import with allow-js flag
import Config from './config';
import MigrationApplication from './migration-application';
import Notification from './notification';
import OAuthAuthorizationCode from './oauth-authorization-code';
import OAuthClient from './oauth-client';
import OAuthDeviceCode from './oauth-device-code';
import OAuthRefreshToken from './oauth-refresh-token';
import Page from './page';
import PageYjsUpdate from './page-yjs-update';
import PendingAuthRegistration from './pending-auth-registration';
import PersonalAccessToken from './personal-access-token';
import PluginRenderCache from './plugin-render-cache';
import Revision from './revision';
import Share from './share';
import ShareAccess from './share-access';
import Tracking from './tracking';
import UpdatePost from './update-post';
import User from './user';
import UserActivation from './user-activation';
import UserIdentity from './user-identity';
import Watcher from './watcher';

export default {
  Page,
  User,
  UserIdentity,
  PendingAuthRegistration,
  UserActivation,
  Revision,
  Backlink,
  Bookmark,
  Comment,
  Attachment,
  UpdatePost,
  Share,
  Tracking,
  ShareAccess,
  Activity,
  Notification,
  Watcher,
  Config,
  MigrationApplication,
  PluginRenderCache,
  PageYjsUpdate,
  PersonalAccessToken,
  OAuthClient,
  OAuthAuthorizationCode,
  OAuthDeviceCode,
  OAuthRefreshToken,
};
