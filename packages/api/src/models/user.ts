import Crowi from 'src/crowi';
import { Types, Document, Schema, model } from 'mongoose';
import type { PaginateModel, PaginateOptions, PaginateResult } from 'mongoose';
import Debug from 'debug';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import async from 'async';
import { googleLoginEnabled, githubLoginEnabled, isDisabledPasswordAuth } from 'src/models/config';
import { createMailTokenUtil } from 'src/util/mail-token';
import { applyPaginatePlugin } from 'src/util/mongoose-paginate';

const STATUS_REGISTERED = 1;
const STATUS_ACTIVE = 2;
const STATUS_SUSPENDED = 3;
const STATUS_DELETED = 4;
const STATUS_INVITED = 5;

/**
 * Case-insensitive collation for the username / email unique indexes
 * (feature-user-identity-uniqueness §b). `strength: 2` folds case (and
 * accents) so `Sotarok` and `sotarok` collide, while the stored value keeps
 * its original casing (display is verbatim). Kept as a module constant so the
 * schema declaration and the migration's duplicate detection use the exact
 * same locale/strength.
 */
export const USER_UNIQUE_COLLATION = { locale: 'en', strength: 2 } as const;

/**
 * Build the tombstone identity for a user being logically deleted
 * (feature-migration-framework §Phase 5, tombstone approach — 2026-06-04).
 *
 * On STATUS_DELETED we discard the original username / email and replace them
 * with per-id sentinels so the **plain** unique indexes (no
 * `partialFilterExpression`, to stay portable to PostgreSQL) never collide a
 * departed user against a living one, and so a living user can re-claim the
 * freed name. The departed user shows as "deleted user" (Slack-style), so the
 * original values are not preserved anywhere.
 *
 * `email` is `required` so it must always carry a value; `username` is
 * `sparse`-indexed so an unset value would also be index-safe, but we set the
 * tombstone there too for consistency (a deleted user reads back as
 * `deleted-<id>` everywhere rather than sometimes blank).
 */
export function tombstoneIdentity(id: { toString(): string }): { username: string; email: string } {
  const suffix = id.toString();
  return { username: `deleted-${suffix}`, email: `deleted-${suffix}@deleted.invalid` };
}
const LANG_EN = 'en';
const LANG_JA = 'ja';
// Legacy regional variants ('en-US' / 'en-GB') were retired; only 'en' / 'ja'
// remain. Existing rows carrying a legacy value are coerced to 'en' by the
// `pre('validate')` hook below, so the tightened enum never rejects them.
const LEGACY_LANGS = ['en-US', 'en-GB'];
const THEME_SYSTEM = 'system';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';
const PAGE_ITEMS = 50;

export interface UserDocument extends Document {
  _id: Types.ObjectId;
  userId: string;
  image: string | null;
  googleId: string | null;
  githubId: string | null;
  name: string;
  username: string;
  email: string;
  introduction: string;
  password: string;
  lang: 'en' | 'ja';
  /**
   * Preferred UI theme, synced across devices (the web client's
   * `next-themes` localStorage value is the per-device fallback). Defaults
   * to `'system'` (follow the OS setting). Added with `required: false` so
   * existing rows are unaffected — they read back the schema default.
   */
  theme: 'system' | 'light' | 'dark';
  status: number;
  createdAt: Date;
  admin: boolean;
  /**
   * When the user confirmed control of their email address. Set on
   * self-registration activation, invite acceptance, and for admin /
   * installer-created accounts. `null` = unconfirmed (self-registered,
   * pending the activation-link click). Login gates on `status`, not on
   * this field, so existing ACTIVE users are unaffected.
   */
  emailConfirmedAt: Date | null;
  /**
   * Session generation. Every web-session JWT (`access` / `refresh`)
   * carries the value it was minted under as its `av` claim, and the auth
   * middleware rejects a token whose `av` no longer matches. Bumping this
   * therefore signs the account out everywhere at once — which is what a
   * self-service password change does (`hono/handlers/me.ts`).
   *
   * Personal access tokens and OAuth access tokens are deliberately NOT
   * affected: they are revoked through their own records.
   *
   * Optional: rows written before the field existed carry no value, which
   * every reader normalises to 0 (see the schema note on why there is no
   * mongoose `default` here).
   */
  authVersion?: number;
  /**
   * Password-reset link generation. A reset mail token carries the value
   * as of issue time; `POST /auth/reset-password` requires it to still
   * match and increments it as it consumes the token, which is what makes
   * a reset link single-use instead of replayable for its full 1h TTL.
   *
   * Optional for the same reason as `authVersion` above.
   */
  passwordResetGeneration?: number;

  isPasswordSet(): boolean;
  isPasswordValid(password: string): boolean;
  setPassword(password: string): this;
  isEmailSet(): boolean;
  updatePassword(password: string, callback: (err: Error | null, userData: UserDocument) => void): void;
  updateImage(image, callback: (err: Error | null, userData: UserDocument) => void): void;
  updateEmail(email: string): any;
  updateNameAndEmail(name: string, email: string): any;
  deleteImage(callback: (err: Error | null, userData: UserDocument) => void): void;
  updateGoogleId(googleId): Promise<UserDocument>;
  deleteGoogleId(): Promise<UserDocument>;
  updateGitHubId(githubId): Promise<UserDocument>;
  deleteGitHubId(): Promise<UserDocument>;
  countValidThirdPartyIds(): number;
  hasValidThirdPartyId(): boolean;
  canDisconnectThirdPartyId(): boolean;
  activateInvitedUser(username, name, password, callback: (err: Error | null, userData: UserDocument) => void): void;
  removeFromAdmin(callback: (err: Error | null, userData: UserDocument) => void): void;
  makeAdmin(callback: (err: Error | null, userData: UserDocument) => void): void;
  statusActivate(callback: (err: Error | null, userData: UserDocument) => void): void;
  statusSuspend(callback: (err: Error | null, userData: UserDocument) => void): void;
  statusDelete(callback: (err: Error | null, userData: UserDocument) => void): void;
  populateSecrets(): Promise<any>;
}

/**
 * `mongoose-paginate-v2` (unlike the unmaintained `mongoose-paginate`) ships
 * its types by augmenting the `mongoose` module: `PaginateResult` /
 * `PaginateOptions` / `PaginateModel` live on `mongoose`. The result envelope
 * renames `total`→`totalDocs` and `pages`→`totalPages`; handlers absorb that
 * rename so the client-facing JSON contract is unchanged. Re-exported here so
 * existing `import { PaginateResult } from 'models/user'` consumers keep working.
 */
export type { PaginateResult, PaginateOptions } from 'mongoose';

export interface UserModel extends PaginateModel<UserDocument> {
  getLanguageLabels(): Record<string, string>;
  getUserStatusLabels(): any;
  isEmailValid(email): boolean;
  isGitHubAccountValid(organizations): boolean;
  findUsers(options, callback: (err: Error | null, userData: UserDocument[]) => void): void;
  findAllUsers(options?): Promise<UserDocument[]>;
  findUsersByIds(ids, options?): Promise<UserDocument[]>;
  findAdmins(callback: (err: Error | null, admins: UserDocument[]) => void): void;
  findUsersWithPagination(options, query, callback): any;
  findUsersByPartOfEmail(emailPart, options): any;
  findUserByUsername(username): Promise<UserDocument | null>;
  findUserByGoogleId(googleId): Promise<UserDocument | null>;
  findUserByGitHubId(githubId): Promise<UserDocument | null>;
  findUserByEmail(email): Promise<UserDocument | null>;
  findUserByEmailAndPassword(email: string, password: string): Promise<UserDocument | null>;
  isRegisterableUsername(username, callback: (registerable: boolean) => void): void;
  isRegisterable(email, username, callback: (registerable: boolean, detail: { email?: boolean; username?: boolean }) => void): void;
  removeCompletelyById(id, callback: (err: Error | null, userData: 1 | null) => void): any;
  resetPasswordByRandomString(id: Types.ObjectId): Promise<{ user: UserDocument; newPassword: string }>;
  createUsersByInvitation(emailList, toSendEmail, callback): any;
  sendInvitationMail(user: UserDocument): Promise<void>;
  createUserByEmailAndPassword(name, username, email, password, lang, callback): any;
  createUserPictureFilePath(user: UserDocument, ext: string): string;
  getUsernameByPath(path): string | null;

  STATUS_REGISTERED: number;
  STATUS_ACTIVE: number;
  STATUS_SUSPENDED: number;
  STATUS_DELETED: number;
  STATUS_INVITED: number;
  PAGE_ITEMS: number;
  LANG_EN: string;
  LANG_JA: string;
  THEME_SYSTEM: string;
  THEME_LIGHT: string;
  THEME_DARK: string;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:user');

  const userEvent = crowi.event('User');

  const userSchema = new Schema<UserDocument, UserModel>({
    userId: String,
    image: String,
    googleId: String,
    githubId: String,
    name: { type: String, index: true },
    username: { type: String },
    email: { type: String, required: true },
    introduction: { type: String },
    password: { type: String, select: false },
    lang: {
      type: String,
      enum: Object.values(getLanguageLabels()),
      default: LANG_EN,
    },
    theme: {
      type: String,
      enum: [THEME_SYSTEM, THEME_LIGHT, THEME_DARK],
      default: THEME_SYSTEM,
    },
    status: { type: Number, required: true, default: STATUS_ACTIVE, index: true },
    createdAt: { type: Date, default: Date.now },
    admin: { type: Boolean, default: false, index: true },
    emailConfirmedAt: { type: Date, default: null },
    // Deliberately declared WITHOUT `default: 0`, unlike every other field
    // here. A schema default is applied when a document that lacks the
    // path is hydrated, and mongoose persists init-applied defaults on the
    // next `save()` (they ride along in the delta even though
    // `isModified()` reports false — verified against this schema). For a
    // counter that is bumped with `$inc` from another request that is a
    // lost update: a request holding a doc hydrated *before* a password
    // change would write the counter back to 0 when it saves, quietly
    // resurrecting the sessions that change had just revoked. Rows written
    // before these fields existed simply carry no value, and every reader
    // normalises with `?? 0`; `$inc` treats a missing field as 0 too, so
    // "absent" and "0" stay interchangeable everywhere.
    authVersion: { type: Number },
    passwordResetGeneration: { type: Number },
  });
  applyPaginatePlugin(userSchema);

  // feature-user-identity-uniqueness — DB-level uniqueness on username / email
  // (the final defence; app-layer findOne pre-checks remain only for UX).
  //
  // Tombstone + plain unique (no partialFilterExpression) so this stays
  // portable to a future PostgreSQL backend (citext / lower() + plain UNIQUE).
  // STATUS_DELETED users are renamed to `deleted-<id>` (see tombstoneIdentity /
  // statusDelete), so they never collide a living user and free their name.
  //
  //  - email: required on every user → plain unique + case-insensitive collation.
  //  - username: `sparse` so the INVITED rows created without a username
  //    (createUsersByInvitation sets no `username` field) stay out of the index
  //    and don't collide on a missing value; collation folds case like email.
  //
  // autoIndex is ON (mongoose default) so a fresh install builds these on boot;
  // the `user-unique-prepare` preflight migration dedups + tombstones existing
  // data so the build never hits E11000 on an in-place v1→v2 upgrade.
  userSchema.index({ email: 1 }, { unique: true, collation: USER_UNIQUE_COLLATION });
  userSchema.index({ username: 1 }, { unique: true, sparse: true, collation: USER_UNIQUE_COLLATION });

  // `onActivated` is async but `emit('activated', ...)` (a synchronous
  // EventEmitter dispatch) does not await it. Track the returned promise so
  // the user-page creation it kicks off — which re-fires page events and
  // fans out to backlink / watch / mention — can be drained by the test
  // harness before disconnect. Production never drains, so this only adds
  // the side-effect to the in-flight set.
  //
  // `onActivated` swallows errors only inside `createUserPage`; its own
  // `findPage()` / `rename()` awaits are not caught, so a rejection there
  // would surface as an unhandled rejection. Attach `.catch(debug)` here so
  // the tracked promise can never reject — symmetric with the other
  // fire-and-forget call sites.
  userEvent.on('activated', (user: UserDocument) => {
    crowi.trackSideEffect(
      Promise.resolve(userEvent.onActivated(user)).catch((err) => {
        debug('userEvent activated handler failed', err);
      }),
    );
  });

  function decideUserStatusOnRegistration() {
    const Config = crowi.model('Config');
    const config = crowi.getConfig();

    if (!config.crowi) {
      return STATUS_ACTIVE; // is this ok?
    }

    // status decided depends on registrationMode
    switch (config.crowi['security:registrationMode']) {
      case Config.SECURITY_REGISTRATION_MODE_OPEN:
        return STATUS_ACTIVE;
      case Config.SECURITY_REGISTRATION_MODE_RESTRICTED:
      case Config.SECURITY_REGISTRATION_MODE_CLOSED: // 一応
        return STATUS_REGISTERED;
      default:
        return STATUS_ACTIVE; // どっちにすんのがいいんだろうな
    }
  }

  function generateRandomTempPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!=-_';
    let password = '';
    const len = 12;

    for (let i = 0; i < len; i++) {
      const randomPoz = Math.floor(Math.random() * chars.length);
      password += chars.substring(randomPoz, randomPoz + 1);
    }

    return password;
  }

  /**
   * Generate password hash using SHA-256 (legacy algorithm)
   * This is kept for backward compatibility with existing passwords
   */
  function generatePasswordLegacy(password) {
    const hasher = crypto.createHash('sha256');
    hasher.update(crowi.env.PASSWORD_SEED + password);

    return hasher.digest('hex');
  }

  /**
   * Generate password hash using bcrypt (recommended)
   * Bcrypt hashes start with $2a$ or $2b$ prefix
   */
  function generatePasswordHash(password) {
    const saltRounds = 10;
    return bcrypt.hashSync(password, saltRounds);
  }

  /**
   * Check if a hash is a bcrypt hash
   * Bcrypt hashes start with $2a$ or $2b$ prefix
   */
  function isBcryptHash(hash: string) {
    return hash && (hash.startsWith('$2a$') || hash.startsWith('$2b$'));
  }

  function getLanguageLabels() {
    const lang = {
      LANG_EN,
      LANG_JA,
    };

    return lang;
  }

  // Coerce a legacy regional `lang` ('en-US' / 'en-GB') to 'en' before
  // validation so saving a doc loaded from a pre-existing row never trips the
  // tightened ['en','ja'] enum. Self-healing: the row is normalised on its
  // next save, no separate data migration required.
  userSchema.pre('validate', async function () {
    if (this.lang && LEGACY_LANGS.includes(this.lang)) {
      this.lang = LANG_EN;
    }
  });

  userSchema.methods.isPasswordSet = function () {
    if (this.password) {
      return true;
    }
    return false;
  };

  userSchema.methods.isPasswordValid = function (password) {
    debug('Password check - stored hash format:', isBcryptHash(this.password) ? 'bcrypt' : 'legacy SHA-256');

    // Check if stored password is a bcrypt hash
    if (isBcryptHash(this.password)) {
      return bcrypt.compareSync(password, this.password);
    }

    // Fall back to legacy SHA-256 verification for backward compatibility
    const inputHash = generatePasswordLegacy(password);
    debug('Password check - stored:', this.password);
    debug('Password check - input hash (legacy):', inputHash);
    debug('Password check - PASSWORD_SEED exists:', !!crowi.env.PASSWORD_SEED);
    return this.password == inputHash;
  };

  userSchema.methods.setPassword = function (password) {
    // Always use bcrypt for new passwords
    this.password = generatePasswordHash(password);
    debug('Password set using bcrypt');
    return this;
  };

  userSchema.methods.isEmailSet = function () {
    if (this.email) {
      return true;
    }
    return false;
  };

  // mongoose 7 dropped the callback form of Document#save(). These public
  // model methods keep their `(err, userData)` callback signature for the
  // handler call sites; only the internal save is switched to the promise
  // form, with this bridge forwarding resolution/rejection to the callback.
  // `doc` is typed by the schema-method `this`, which mongoose 8 hydrates to
  // a richer type than the bare `UserDocument`, so accept any saveable doc.
  function bridgeSave(saving: Promise<unknown>, fallback: unknown, callback: (err: Error | null, userData: UserDocument) => void): void {
    saving.then(
      (userData) => callback(null, userData as UserDocument),
      // On a save failure there is no saved document; the legacy callback
      // form also surfaced the in-memory doc, so forward it as the error case.
      (err) => callback(err as Error, fallback as UserDocument),
    );
  }

  userSchema.methods.updatePassword = function (password, callback) {
    this.setPassword(password);
    bridgeSave(this.save(), this, callback);
  };

  userSchema.methods.updateImage = function (image, callback) {
    this.image = image;
    bridgeSave(this.save(), this, callback);
  };

  userSchema.methods.updateEmail = function (email) {
    this.email = email;
    return this.save();
  };

  userSchema.methods.updateNameAndEmail = function (name, email) {
    this.name = name;
    this.email = email;
    return this.save();
  };

  userSchema.methods.deleteImage = function (callback) {
    return this.updateImage(null, callback);
  };

  userSchema.methods.updateGoogleId = function (googleId) {
    this.googleId = googleId;
    return this.save();
  };

  userSchema.methods.deleteGoogleId = function () {
    return this.updateGoogleId(null);
  };

  userSchema.methods.updateGitHubId = function (githubId) {
    this.githubId = githubId;
    return this.save();
  };

  userSchema.methods.deleteGitHubId = function () {
    return this.updateGitHubId(null);
  };

  userSchema.methods.countValidThirdPartyIds = function () {
    const config = crowi.getConfig();
    const googleId = googleLoginEnabled(config) && this.googleId;
    const githubId = githubLoginEnabled(config) && this.githubId;
    const validIds = [googleId, githubId].filter(Boolean);
    return validIds.length;
  };

  userSchema.methods.hasValidThirdPartyId = function () {
    return this.countValidThirdPartyIds() > 0;
  };

  userSchema.methods.canDisconnectThirdPartyId = function () {
    const config = crowi.getConfig();
    return !isDisabledPasswordAuth(config) || this.countValidThirdPartyIds() > 1;
  };

  userSchema.methods.activateInvitedUser = function (username, name, password, callback) {
    this.setPassword(password);
    this.name = name;
    this.username = username;
    this.status = STATUS_ACTIVE;
    // Clicking the invite link proves control of the email address.
    this.emailConfirmedAt = new Date();
    this.save().then(
      (userData) => {
        userEvent.emit('activated', userData);
        return callback(null, userData);
      },
      (err) => callback(err as Error, this as unknown as UserDocument),
    );
  };

  userSchema.methods.removeFromAdmin = function (callback) {
    debug('Remove from admin', this);
    this.admin = false;
    bridgeSave(this.save(), this, callback);
  };

  userSchema.methods.makeAdmin = function (callback) {
    debug('Admin', this);
    this.admin = true;
    bridgeSave(this.save(), this, callback);
  };

  userSchema.methods.statusActivate = function (callback) {
    debug('Activate User', this);
    this.status = STATUS_ACTIVE;
    this.save().then(
      (userData) => {
        userEvent.emit('activated', userData);
        return callback(null, userData);
      },
      (err) => callback(err as Error, this as unknown as UserDocument),
    );
  };

  userSchema.methods.statusSuspend = function (callback) {
    debug('Suspend User', this);
    this.status = STATUS_SUSPENDED;
    if (this.email === undefined || this.email === null) {
      // migrate old data
      this.email = '-';
    }
    if (this.name === undefined || this.name === null) {
      // migrate old data
      this.name = '-' + Date.now();
    }
    if (this.username === undefined || this.username === null) {
      // migrate old data
      this.username = '-';
    }
    bridgeSave(this.save(), this, callback);
  };

  userSchema.methods.statusDelete = function (callback) {
    debug('Delete User', this);
    this.status = STATUS_DELETED;
    this.password = '';
    // Tombstone the identity: discard the original username / email and write
    // per-id sentinels so the plain unique indexes free the name for re-use and
    // never collide this departed user against a living one (Phase 5 tombstone
    // approach). The former fixed `deleted@deleted` email collided across every
    // deleted user under a plain unique index.
    const tombstone = tombstoneIdentity(this._id);
    this.username = tombstone.username;
    this.email = tombstone.email;
    this.googleId = null;
    this.image = null;
    bridgeSave(this.save(), this, callback);
  };

  userSchema.methods.populateSecrets = async function () {
    return User.findById(this._id, '+password').exec();
  };

  userSchema.statics.getLanguageLabels = getLanguageLabels;
  userSchema.statics.getUserStatusLabels = function () {
    const userStatus = {};
    userStatus[STATUS_REGISTERED] = '承認待ち';
    userStatus[STATUS_ACTIVE] = 'Active';
    userStatus[STATUS_SUSPENDED] = 'Suspended';
    userStatus[STATUS_DELETED] = 'Deleted';
    userStatus[STATUS_INVITED] = '招待済み';

    return userStatus;
  };

  userSchema.statics.isEmailValid = function (email) {
    const config = crowi.getConfig();
    const whitelist = config.crowi['security:registrationWhiteList'];

    if (!Array.isArray(whitelist) || whitelist.length === 0) {
      return true;
    }

    const target = String(email ?? '')
      .trim()
      .toLowerCase();
    if (target.length === 0) return false;

    // Each whitelist entry is matched as a literal (no regex), case-insensitively:
    //   - 'admin@example.com'  → exact full-address match
    //   - '@example.com'       → any local-part at that domain
    //   - 'example.com'        → that domain or any subdomain of it
    // This replaces the legacy `new RegExp(entry + '$')`, which left entries
    // unanchored at the start (so 'example.com' also matched 'notexample.com'),
    // unescaped (metachars like '.' matched any char; a bad entry threw), and
    // case-sensitive.
    return whitelist.some(function (allowedEmail) {
      const entry = String(allowedEmail ?? '')
        .trim()
        .toLowerCase();
      if (entry.length === 0) return false;
      if (entry.startsWith('@')) return target.endsWith(entry);
      if (entry.includes('@')) return target === entry;
      return target.endsWith(`@${entry}`) || target.endsWith(`.${entry}`);
    });
  };

  userSchema.statics.isGitHubAccountValid = function (organizations) {
    const config = crowi.getConfig();
    const org = config.crowi['github:organization'];

    const orgs = organizations || [];

    return !org || orgs.includes(org);
  };

  userSchema.statics.findUsers = function (options, callback) {
    const sort = options.sort || { status: 1, createdAt: 1 };

    // mongoose 7 dropped Query#exec(callback); bridge the promise to the
    // existing callback signature.
    this.find()
      .sort(sort)
      .skip(options.skip || 0)
      .limit(options.limit || 21)
      .exec()
      .then(
        (userData) => callback(null, userData),
        (err) => callback(err as Error, []),
      );
  };

  userSchema.statics.findAllUsers = function (options = {}) {
    const sort = options.sort || { createdAt: -1 };
    let status = options.status || [STATUS_ACTIVE, STATUS_SUSPENDED];
    const fields = options.fields;

    if (!Array.isArray(status)) {
      status = [status];
    }

    return User.find()
      .or(
        status.map((s) => {
          return { status: s };
        }),
      )
      .select(fields)
      .sort(sort)
      .exec();
  };

  userSchema.statics.findUsersByIds = function (ids, options = {}) {
    const sort = options.sort || { createdAt: -1 };
    const status = options.status || STATUS_ACTIVE;
    const fields = options.fields;

    return User.find({ _id: { $in: ids }, status: status })
      .select(fields)
      .sort(sort)
      .exec();
  };

  userSchema.statics.findAdmins = function (callback) {
    this.find({ admin: true })
      .exec()
      .then(
        (admins) => {
          debug('Admins: ', admins);
          callback(null, admins);
        },
        (err) => callback(err as Error, []),
      );
  };

  userSchema.statics.findUsersWithPagination = function (options, query, callback) {
    const sort = options.sort || { status: 1, username: 1, createdAt: 1 };

    // mongoose-paginate-v2 returns a promise; the callback form was removed.
    // Result fields totalDocs/totalPages replace mongoose-paginate's
    // total/pages — callers that need the legacy names absorb the rename.
    this.paginate(query, {
      page: options.page || 1,
      limit: options.limit || PAGE_ITEMS,
      sort,
      // Drop secret fields at the Mongo layer instead of stripping them
      // client-side via toUserPublic. Saves bandwidth between Mongo and
      // Node and ensures no admin handler accidentally leaks a hash.
      select: '-password -googleId -githubId',
    }).then(
      (result) => callback(null, result),
      (err) => {
        debug('Error on pagination:', err);
        return callback(err, null);
      },
    );
  };

  userSchema.statics.findUsersByPartOfEmail = function (emailPart, options) {
    const status = options.status || null;
    const emailPartRegExp = new RegExp(emailPart.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));

    const query = User.find({ email: emailPartRegExp });

    if (status) {
      query.and({ status } as any);
    }

    return query.limit(PAGE_ITEMS + 1).exec();
  };

  userSchema.statics.findUserByUsername = function (username) {
    return User.findOne({ username }).exec();
  };

  userSchema.statics.findUserByGoogleId = function (googleId) {
    return User.findOne({ googleId }).exec();
  };

  userSchema.statics.findUserByGitHubId = function (githubId) {
    return User.findOne({ githubId }).exec();
  };

  userSchema.statics.findUserByEmail = function (email) {
    return User.findOne({ email }).exec();
  };

  userSchema.statics.findUserByEmailAndPassword = async function (email, password) {
    // First, try to find user by email and legacy SHA-256 hash (for backward compatibility)
    const hashedPasswordLegacy = generatePasswordLegacy(password);
    let user = await User.findOne({ email, password: hashedPasswordLegacy }).select('+password').exec();

    if (user) {
      debug('User found with legacy SHA-256 password');
      return user;
    }

    // If not found, find user by email and verify bcrypt password
    user = await User.findOne({ email }).select('+password').exec();
    if (user && user.password && isBcryptHash(user.password)) {
      const isValid = bcrypt.compareSync(password, user.password);
      if (isValid) {
        debug('User found with bcrypt password');
        return user;
      }
    }

    return null;
  };

  userSchema.statics.isRegisterableUsername = async function (username, callback) {
    const userData = await User.findOne({ username });
    if (userData) {
      return callback(false);
    }

    return callback(true);
  };

  userSchema.statics.isRegisterable = async function (email, username, callback) {
    let emailUsable = true;
    let usernameUsable = true;
    let userData: UserDocument | null = null;

    // username check
    userData = await User.findOne({ username });
    if (userData) {
      usernameUsable = false;
    }

    // email check
    userData = await User.findOne({ email });
    if (userData) {
      emailUsable = false;
    }

    if (!emailUsable || !usernameUsable) {
      return callback(false, { email: emailUsable, username: usernameUsable });
    }

    return callback(true, {});
  };

  userSchema.statics.removeCompletelyById = function (id, callback) {
    // mongoose 7 dropped findById(cb) and Document#remove(); use the promise
    // form + deleteOne(). The public (err, 1|null) callback is preserved.
    User.findById(id)
      .then((userData) => {
        if (!userData) {
          return callback(null, null);
        }

        debug('Removing user:', userData);
        // 物理削除可能なのは、招待中ユーザーのみ
        // 利用を一度開始したユーザーは論理削除のみ可能
        if (userData.status !== STATUS_INVITED) {
          return callback(new Error('Cannot remove completely the user whoes status is not INVITED'), null);
        }

        return userData.deleteOne().then(
          () => callback(null, 1),
          (err) => callback(err as Error, null),
        );
      })
      .catch((err) => callback(err as Error, null));
  };

  userSchema.statics.resetPasswordByRandomString = async function (id) {
    const userData = await User.findById(id);
    if (!userData) {
      throw new Error('User not found');
    }

    // is updatable check
    // if (userData.isUp
    const newPassword = generateRandomTempPassword();
    userData.setPassword(newPassword);
    const user = await userData.save();

    return { user, newPassword };
  };

  /**
   * Issue a fresh invite token and send the invitation email for `user`.
   *
   * Shared by the initial invitation (`createUsersByInvitation`) and the
   * admin "resend invite" action so the token issuance + invite-link
   * assembly + `mailer.send('invite')` live in exactly one place. The
   * token is a stateless JWT (`util/mail-token.ts`, TTL 7 days, not stored
   * in the DB), so a resend simply signs a new token — no old-token
   * invalidation is needed; the accept handler's status check rejects a
   * second acceptance.
   *
   * Throws on a send failure. Callers that must not abort their wider
   * operation (the batch invite, where one bad address must not stop the
   * rest) wrap this in try/catch; the resend handler lets the throw
   * surface so it can be mapped to a 5xx.
   */
  userSchema.statics.sendInvitationMail = async function (user: UserDocument): Promise<void> {
    const mailer = crowi.getMailer();
    const mailTokenUtil = createMailTokenUtil();
    // Absolute base for the invite link (CLIENT_URL).
    const baseUrl = crowi.getBaseUrl() || '';
    // Token-based invite link — no plaintext password is ever emailed; the
    // invitee sets their own credentials on accept.
    const { token } = mailTokenUtil.signMailToken({
      purpose: 'invite',
      userId: user._id.toString(),
      email: user.email,
    });
    const inviteUrl = `${baseUrl}/invite/accept?token=${token}`;

    await mailer.send({
      to: user.email,
      htmlTemplate: 'invite',
      vars: { ...mailer.brandVars(), inviteUrl, email: user.email },
    });
  };

  userSchema.statics.createUsersByInvitation = function (emailList, toSendEmail, callback) {
    const createdUserList: {
      email: string;
      password: string | null;
      user: UserDocument | null;
    }[] = [];
    const config = crowi.getConfig();

    if (!Array.isArray(emailList)) {
      debug('emailList is not array');
    }

    async.each(
      emailList,
      function (email, next) {
        const newUser = new User();
        let password;

        email = email.trim();

        // email check
        // TODO: 削除済みはチェック対象から外そう〜
        // mongoose 7 dropped the callback forms of findOne()/save(); use
        // promises inside the async.each iteratee, still calling next().
        User.findOne({ email })
          .then((user) => {
            // The user is exists
            if (user) {
              createdUserList.push({ email, password: null, user: null });

              return next();
            }

            password = Math.random().toString(36).slice(-16);

            newUser.email = email;
            newUser.setPassword(password);
            newUser.createdAt = Date.now() as any;
            newUser.status = STATUS_INVITED;

            return newUser.save().then(
              (saved) => {
                createdUserList.push({ email, password, user: saved });
                debug('saved!', email);
                next();
              },
              () => {
                createdUserList.push({ email, password: null, user: null });
                debug('save failed!! ', email);
                next();
              },
            );
          })
          .catch(() => {
            createdUserList.push({ email, password: null, user: null });
            debug('save failed!! ', email);
            next();
          });
      },
      function (err) {
        if (err) {
          debug('error occured while iterate email list');
        }

        if (toSendEmail) {
          async.each(
            createdUserList,
            function (item, next) {
              // Skip rows that already existed or failed to save.
              if (!item.user) {
                return next();
              }

              // Token issuance + invite-link assembly + send is shared with
              // the admin "resend invite" action via `sendInvitationMail`.
              // A send failure must not abort the batch — log and continue
              // so the remaining invitations still go out.
              User.sendInvitationMail(item.user)
                .then(() => debug('completed to send invitation to', item.email))
                .catch((err) => debug('failed to send invitation email: ', err))
                .finally(() => next());
            },
            function (err) {
              debug('Sending invitation email completed.', err);
            },
          );
        }

        debug('createdUserList!!! ', createdUserList);
        return callback(null, createdUserList);
      },
    );
  };

  userSchema.statics.createUserByEmailAndPassword = function (name, username, email, password, lang, callback) {
    const newUser = new User();

    newUser.name = name;
    newUser.username = username;
    newUser.email = email;
    newUser.setPassword(password);
    newUser.lang = lang;
    newUser.createdAt = Date.now() as any;
    newUser.status = decideUserStatusOnRegistration();

    // mongoose 7 dropped Document#save(callback); bridge the promise.
    newUser.save().then(
      (userData) => {
        if (userData.status == STATUS_ACTIVE) {
          userEvent.emit('activated', userData);
        }
        return callback(null, userData);
      },
      (err) => callback(err as Error, null),
    );
  };

  userSchema.statics.createUserPictureFilePath = function (user, ext) {
    ext = '.' + ext;

    return 'user/' + user._id + ext;
  };

  userSchema.statics.getUsernameByPath = function (path) {
    let username = null;
    let m;
    if ((m = path.match(/^\/user\/([^/]+)\/?/))) {
      username = m[1];
    }

    return username;
  };

  const User = model<UserDocument, UserModel>('User', userSchema);

  // 静的プロパティをスキーマではなくモデルに直接割り当て
  User.STATUS_REGISTERED = STATUS_REGISTERED;
  User.STATUS_ACTIVE = STATUS_ACTIVE;
  User.STATUS_SUSPENDED = STATUS_SUSPENDED;
  User.STATUS_DELETED = STATUS_DELETED;
  User.STATUS_INVITED = STATUS_INVITED;
  User.PAGE_ITEMS = PAGE_ITEMS;

  User.LANG_EN = LANG_EN;
  User.LANG_JA = LANG_JA;

  User.THEME_SYSTEM = THEME_SYSTEM;
  User.THEME_LIGHT = THEME_LIGHT;
  User.THEME_DARK = THEME_DARK;

  return User;
};
