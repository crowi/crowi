import { z } from '@hono/zod-openapi';
import { UserPublicSchema } from './userPublic';

/**
 * RFC-0003 shared schemas for the realtime collaborative editing
 * feature. Phase 1 introduces only the types — they are wired into
 * the actual ts-rest contracts and Hocuspocus message handlers in
 * later phases:
 *
 *   - Phase 2 (`GET /api/v2/pages/:id/yjs-token`) consumes
 *     `WsTokenResponseSchema`.
 *   - Phase 5 (Hocuspocus custom message handler) consumes
 *     `CollabSaveMessageSchema` and `CollabSaveErrorSchema`.
 *   - Phase 7 (Revision list view) and the page-detail flow consume
 *     `ContributorRefSchema`.
 *
 * Keeping the types here (and not in `page.ts`) keeps the
 * collaborative additions discoverable as one bundle and avoids
 * polluting the legacy page contract with v2.1-only fields.
 */

/**
 * Public user shape surfaced for collaboration UI (Save author /
 * contributors / awareness presence). Re-export of `UserPublicSchema`
 * under a more intent-revealing alias.
 */
export const ContributorRefSchema = UserPublicSchema;
export type ContributorRef = z.infer<typeof ContributorRefSchema>;

/**
 * `Revision.type` discriminator: every 10th checkpoint stores the
 * full Y.Doc state (`'snapshot'`), the 9 in between only the binary
 * delta from the previous revision (`'incremental'`). Undefined on
 * pre-RFC-0003 revisions and treated as `'snapshot'` by callers.
 *
 * Defined once here so the Mongoose model (`packages/api/src/models/
 * revision.ts`) and the wire-format `RevisionSchema` (`./page.ts`)
 * never drift — without this anchor the enum had two literal
 * declarations and Phase 5 risked widening one without the other.
 */
export const RevisionTypeSchema = z.enum(['snapshot', 'incremental']);
export type RevisionType = z.infer<typeof RevisionTypeSchema>;

/**
 * Response body of the Phase 2 wsToken endpoint
 * (`GET /api/v2/pages/:id/yjs-token`). The Hocuspocus client
 * (`HocuspocusProvider`) takes the `wsToken` and presents it on
 * connect; the server validates it via `onAuthenticate`.
 *
 *   - `wsToken`     — short-lived JWT (5 min)
 *   - `pageId`      — the page id this token is scoped to (mirrors
 *                     the request param; clients use this to detect
 *                     misroute)
 *   - `expiresAt`   — ISO 8601 timestamp; clients use this to
 *                     proactively refresh before WebSocket close
 *   - `readonly`    — `true` once the 20-user editor cap is reached;
 *                     readonly clients still subscribe to live
 *                     updates but their writes are rejected by
 *                     Hocuspocus.
 */
export const WsTokenResponseSchema = z.object({
  wsToken: z.string(),
  pageId: z.string(),
  expiresAt: z.string(),
  readonly: z.boolean(),
});
export type WsTokenResponse = z.infer<typeof WsTokenResponseSchema>;

/**
 * Decoded payload of the short-lived wsToken JWT. The server signs
 * this with `WS_TOKEN_SECRET` (Phase 2) and Hocuspocus verifies it on
 * `onAuthenticate` (Phase 3). Phase 1 exports the schema so both
 * ends can validate the payload shape with the same source of truth.
 *
 *   - `userId`   — JWT subject = the connecting user's `_id`
 *   - `pageId`   — scoping the token to a single page; Hocuspocus
 *                  rejects mismatches in `onAuthenticate`
 *   - `readonly` — sticky readonly bit set when the editor cap is
 *                  exhausted at issue time
 *   - `iat`/`exp` — standard JWT claims (seconds since epoch);
 *                  `exp - iat` is 5 minutes
 */
export const WsTokenPayloadSchema = z.object({
  userId: z.string(),
  pageId: z.string(),
  readonly: z.boolean(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type WsTokenPayload = z.infer<typeof WsTokenPayloadSchema>;

/**
 * Client → server custom message that triggers a checkpoint Revision
 * inside Hocuspocus. Phase 5 wires this into the Hocuspocus message
 * dispatcher; Phase 8 wires it to the Save button.
 *
 * `message` is the optional checkpoint message (currently unused in
 * the v2.1 UI per spec open question 1, but reserved on the wire so
 * we can light it up without a wire-format break).
 */
export const CollabSaveMessageSchema = z.object({
  kind: z.literal('crowi:save'),
  message: z.string().optional(),
});
export type CollabSaveMessage = z.infer<typeof CollabSaveMessageSchema>;

/**
 * Server → client success message after a checkpoint Revision lands.
 * Phase 5 emits this via Hocuspocus's stateless channel; Phase 8 will
 * surface `revisionId` in the Save button's success toast so users can
 * link straight to the new revision.
 */
export const CollabSaveOkSchema = z.object({
  kind: z.literal('crowi:save-ok'),
  revisionId: z.string(),
});
export type CollabSaveOk = z.infer<typeof CollabSaveOkSchema>;

/**
 * Server → client error message emitted when a Hocuspocus-side save
 * fails. The Phase 8 Save UI surfaces `message` in a toast. `code`
 * lets the client branch on retry vs surface-and-stop (e.g.
 * `'RENDERER_FAILED'` is a hard error from the RFC-0002 renderer; the
 * client should not retry).
 */
export const CollabSaveErrorSchema = z.object({
  kind: z.literal('crowi:save-error'),
  code: z.string(),
  message: z.string(),
});
export type CollabSaveError = z.infer<typeof CollabSaveErrorSchema>;

/**
 * Server → client force-reload message. Emitted when the latest
 * revision's body is mutated outside the Yjs flow (admin tool,
 * legacy `/_api`, manual MongoDB edit) — Phase 6 detects this via
 * `Page.yjsState === null` in `onLoadDocument` and broadcasts the
 * message before terminating the connection.
 */
export const CollabForceReloadMessageSchema = z.object({
  kind: z.literal('crowi:force-reload'),
  reason: z.string().optional(),
});
export type CollabForceReloadMessage = z.infer<typeof CollabForceReloadMessageSchema>;
