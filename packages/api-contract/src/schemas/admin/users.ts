import { z } from '@hono/zod-openapi';
import { UserPublicSchema } from '../user-public';
import { AdminPagerSchema } from './_pager';

export { AdminPagerSchema, type AdminPager } from './_pager';

/**
 * Query parameters accepted by GET /admin/users.
 *
 * - `q` is the free-text search; legacy controller used `uq` but we adopt the
 *   shorter `q` for the new endpoint. See architecturalNotes in the migration
 *   task. The server side splits on whitespace and joins with `|` to build a
 *   single regex (case-insensitive) matched against username / name / email.
 * - `page` defaults to 1.
 * - `limit` defaults to 50 (== legacy User.PAGE_ITEMS) and is capped at 100.
 *
 * `z.coerce.number()` accepts the string-form values that arrive from
 * `req.query` while remaining typed as `number` downstream.
 */
export const ListAdminUsersRequestSchema = z.object({
  q: z.string().optional(),
  /**
   * Optional numeric user-status filter (see `UserStatusEnum`). When set, only
   * users in that status are returned — used by the "user approval" queue
   * screen to list `REGISTERED` (= awaiting admin approval) users.
   */
  status: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListAdminUsersRequest = z.infer<typeof ListAdminUsersRequestSchema>;

/**
 * A `UserPublic` row plus the provider slugs this user has a federated
 * identity for. Deliberately NOT folded into `UserPublicSchema` — that
 * schema is shared by every admin endpoint that returns a user (edit,
 * makeAdmin, resetPassword, ...), and adding `linkedProviders` there would
 * leak it into responses that never populate it. Only the list route
 * computes and attaches this field.
 */
export const AdminUserListItemSchema = UserPublicSchema.extend({
  linkedProviders: z.array(z.string()),
});
export type AdminUserListItem = z.infer<typeof AdminUserListItemSchema>;

/**
 * Response body for GET /admin/users.
 *
 * Note: even though the legacy endpoint also returned the original `uq` echo,
 * we drop it from the new contract — the client owns the search input state
 * and does not need the server to round-trip the query back.
 */
export const ListAdminUsersResponseSchema = z.object({
  users: z.array(AdminUserListItemSchema),
  pager: AdminPagerSchema,
});
export type ListAdminUsersResponse = z.infer<typeof ListAdminUsersResponseSchema>;

/**
 * Query parameters for GET /admin/users/search (email autocomplete).
 *
 * The legacy endpoint accepted `email` and matched as a regex (with the
 * special characters escaped server-side). We preserve the same shape so
 * pre-existing autocomplete callers can switch to the new endpoint with
 * minimal change.
 */
export const SearchAdminUsersByEmailRequestSchema = z.object({
  email: z.string().min(1),
});
export type SearchAdminUsersByEmailRequest = z.infer<typeof SearchAdminUsersByEmailRequestSchema>;

/**
 * Response body for GET /admin/users/search.
 *
 * The legacy endpoint wrapped users in `{ data: [...] }`; the new shape uses
 * the more conventional `{ users: [...] }` for parity with the list endpoint.
 * Up to PAGE_ITEMS+1 (= 51) results are returned so a UI can detect "more
 * results than shown" without an extra count query.
 */
export const SearchAdminUsersByEmailResponseSchema = z.object({
  users: z.array(UserPublicSchema),
});
export type SearchAdminUsersByEmailResponse = z.infer<typeof SearchAdminUsersByEmailResponseSchema>;

/**
 * Path-param schema reused by every per-user mutating endpoint
 * (edit / makeAdmin / removeFromAdmin / activate / suspend / resetPassword /
 * updateEmail). Strict 24-char hex validation lives in the handler so we can
 * surface a consistent 400 ValidationError; here we just declare the shape.
 */
export const AdminUserIdParamSchema = z.object({
  id: z.string(),
});
export type AdminUserIdParam = z.infer<typeof AdminUserIdParamSchema>;

/**
 * Request body for POST /admin/users/invite.
 *
 * The legacy form accepted a single newline-separated `emailList` string; the
 * new contract takes a clean `string[]` so the client owns the splitting and
 * trimming. `sendEmail` toggles the post-invite mailer (template
 * `admin/userInvitation.txt`); defaults to false to keep the side-effect
 * opt-in.
 */
export const InviteUsersRequestSchema = z.object({
  emailList: z.array(z.string().email()).min(1),
  sendEmail: z.boolean().optional().default(false),
});
export type InviteUsersRequest = z.infer<typeof InviteUsersRequestSchema>;

/**
 * Per-email outcome produced by `User.createUsersByInvitation`. Normalized to
 * a discriminator so clients can render success/duplicate/failure rows with a
 * simple switch.
 *
 * - 'created' -> a new user was inserted; userId is the new ObjectId
 * - 'exists'  -> an active or invited user already had this email; no insert
 * - 'failed'  -> save() rejected (rare; e.g. invalid email after coercion).
 *                We surface it instead of swallowing so admins notice partial
 *                success.
 */
export const InvitedUserResultSchema = z.discriminatedUnion('status', [
  z.object({
    email: z.string(),
    status: z.literal('created'),
    userId: z.string(),
  }),
  z.object({
    email: z.string(),
    status: z.literal('exists'),
  }),
  z.object({
    email: z.string(),
    status: z.literal('failed'),
  }),
]);
export type InvitedUserResult = z.infer<typeof InvitedUserResultSchema>;

export const InviteUsersResponseSchema = z.object({
  results: z.array(InvitedUserResultSchema),
});
export type InviteUsersResponse = z.infer<typeof InviteUsersResponseSchema>;

/**
 * Request body for PATCH /admin/users/:id. Writes only `name` — a federated
 * user's email has to be lockable against admin-side edits, and that lock
 * only has one place to live if there is only one email-writing route.
 * `PUT /admin/users/:id/email` is the sole email-change path.
 */
export const EditAdminUserRequestSchema = z.object({
  name: z.string().min(1),
});
export type EditAdminUserRequest = z.infer<typeof EditAdminUserRequestSchema>;

/**
 * Response body for the user-mutating endpoints that return the updated user
 * (edit / makeAdmin / removeFromAdmin / activate / suspend / updateEmail).
 *
 * We always shape it as `{ user: UserPublic }` (rather than returning the bare
 * UserPublic) so future fields like `message` or `previousEmail` can be added
 * without a breaking response change.
 */
export const AdminUserMutationResponseSchema = z.object({
  user: UserPublicSchema,
});
export type AdminUserMutationResponse = z.infer<typeof AdminUserMutationResponseSchema>;

/**
 * Response body for POST /admin/users/:id/reset-password.
 *
 * Mirrors the legacy `User.resetPasswordByRandomString` contract: returns the
 * generated plaintext password alongside the updated user. The plaintext
 * disclosure is preserved for parity with the legacy admin UI; switching to
 * an email-delivered reset is tracked in the task openQuestions.
 */
export const ResetPasswordResponseSchema = z.object({
  user: UserPublicSchema,
  newPassword: z.string(),
});
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;

/**
 * Request body for PUT /admin/users/:id/email.
 *
 * Email-only update. The legacy endpoint took `{ user_id, email }` in the
 * body; with the user id now in the path, only `email` remains.
 */
export const UpdateAdminUserEmailRequestSchema = z.object({
  email: z.string().email(),
});
export type UpdateAdminUserEmailRequest = z.infer<typeof UpdateAdminUserEmailRequestSchema>;

/**
 * 409 sibling to `ConflictErrorSchema` on PUT /admin/users/:id/email,
 * returned instead of a write when the target has a federated identity and
 * the request would move their email away from the IdP-verified address.
 * Kept as its own literal-code schema (not folded into the shared
 * `ConflictErrorSchema`, and not registered on the central `ErrorCodeSchema`
 * enum) so this one feature's error shape does not widen either shared
 * contract — the route declares both as a union response instead.
 */
export const EmailLockedByFederatedIdentityErrorSchema = z.object({
  error: z.object({
    code: z.literal('EMAIL_LOCKED_BY_FEDERATED_IDENTITY'),
    message: z.string(),
  }),
});
export type EmailLockedByFederatedIdentityError = z.infer<typeof EmailLockedByFederatedIdentityErrorSchema>;

/**
 * Path params for DELETE /admin/users/:id/identities/:provider.
 */
export const AdminUserIdentityParamSchema = AdminUserIdParamSchema.extend({
  provider: z.string(),
});
export type AdminUserIdentityParam = z.infer<typeof AdminUserIdentityParamSchema>;

/**
 * Response body for DELETE /admin/users/:id/identities/:provider.
 *
 * `passwordIssued` tells the caller which of the two admin-unlink paths ran
 * (spec design decision: issue a password only when the target has none) so
 * the UI can show "share this new password" vs "the password was not
 * touched". `newPassword` is present only when `passwordIssued` is true.
 */
export const UnlinkUserIdentityResponseSchema = z.object({
  user: UserPublicSchema,
  passwordIssued: z.boolean(),
  newPassword: z.string().optional(),
});
export type UnlinkUserIdentityResponse = z.infer<typeof UnlinkUserIdentityResponseSchema>;

/**
 * 404 for DELETE /admin/users/:id/identities/:provider: either the user id
 * resolves to nothing (`NOT_FOUND`), or the user exists but has no identity
 * for the given provider (`NOT_LINKED`). Combined into one schema (mirroring
 * `UnlinkAuthProviderErrorSchema`'s self-service sibling) since a single
 * response status can declare only one content schema.
 */
export const UnlinkUserIdentityNotFoundErrorSchema = z.object({
  error: z.object({
    code: z.enum(['NOT_FOUND', 'NOT_LINKED']),
    message: z.string(),
  }),
});
export type UnlinkUserIdentityNotFoundError = z.infer<typeof UnlinkUserIdentityNotFoundErrorSchema>;

/**
 * 409 for DELETE /admin/users/:id/identities/:provider: refused because the
 * target is the operating admin themself (`CANNOT_UNLINK_SELF`), or because
 * password auth is disabled instance-wide so issuing a password would not
 * help (`PASSWORD_AUTH_DISABLED`).
 */
export const UnlinkUserIdentityConflictErrorSchema = z.object({
  error: z.object({
    code: z.enum(['CANNOT_UNLINK_SELF', 'PASSWORD_AUTH_DISABLED']),
    message: z.string(),
  }),
});
export type UnlinkUserIdentityConflictError = z.infer<typeof UnlinkUserIdentityConflictErrorSchema>;

/**
 * Response body for DELETE /admin/users/:id.
 *
 * Only users still in the INVITED status can be physically removed
 * (`User.removeCompletelyById`); activated users are logically deleted via the
 * suspend/delete status flow instead. Returns the removed id so the client can
 * drop the row optimistically.
 */
export const DeleteAdminUserResponseSchema = z.object({
  deletedId: z.string(),
});
export type DeleteAdminUserResponse = z.infer<typeof DeleteAdminUserResponseSchema>;

/**
 * Response body for GET /admin/users/pending-count.
 *
 * `count` is the number of users awaiting admin approval (status REGISTERED).
 * Drives the "user approval" sidebar badge so admins notice pending sign-ups.
 */
export const PendingUsersCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type PendingUsersCountResponse = z.infer<typeof PendingUsersCountResponseSchema>;
