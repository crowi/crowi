import type { onAuthenticatePayload } from '@hocuspocus/server';
import Debug from 'debug';
import { resolvePageEpoch } from '../doc-epoch';
import type { CollabModels } from '../models';
import { DELETED_STATUS, DRAFT_STATUS } from '../page-status';
import { type CollabContext, type CollabWsTokenUtil, type EditorCapCounter, noopEditorCapCounter } from '../types';

/**
 * Default no-op cap peek. The api process injects a Redis-backed peek
 * via `attachCollabServer`'s deps; tests that don't care about cap
 * leave the default — `readonly: false` so connections flow.
 */
const defaultCheckEditorCap = async (_pageId: string): Promise<{ readonly: boolean }> => ({ readonly: false });

const debug = Debug('crowi:collab:auth');

/**
 * editor-preview-reliability §6 — promote the two diagnostics that
 * actually explain a "WebSocket closed before the connection was
 * established" report (token verify failure + cap-driven readonly) from
 * `debug()` (invisible in prod) to a sampled `console.warn`. Sampling
 * keeps a token-replay flood or a busy 20-cap page from drowning the
 * logs while still surfacing the signal an operator needs to tell apart
 * "expired token / wrong secret / clock skew" from "page is full".
 *
 * 1-in-N sampling via a per-process counter (no timers, no deps). N=20
 * is a pragmatic floor: frequent enough to catch a steady-state problem
 * within a few seconds of normal traffic, sparse enough to stay quiet.
 */
const WARN_SAMPLE_RATE = 20;
let warnSampleCounter = 0;
function sampledWarn(message: string): void {
  warnSampleCounter += 1;
  if (warnSampleCounter % WARN_SAMPLE_RATE === 1) {
    console.warn(`[crowi:collab] ${message} (sampled 1/${WARN_SAMPLE_RATE})`);
  }
}

/**
 * Minimal `findById(...).select(...).lean().exec()` chain shape — only
 * the methods this hook touches. Keeps the cast narrow instead of
 * reaching for `any` on the loosely-typed `CollabModels.Page`.
 */
interface DraftablePageQuery {
  select(fields: string): {
    lean(): { exec(): Promise<unknown> };
  };
}
interface DraftablePageModel {
  findById(id: string): DraftablePageQuery;
}

/** Projection returned by the draft-author lookup above. */
interface DraftablePageRow {
  _id: unknown;
  status?: string;
  creator?: unknown;
  /** RFC-0017 Phase 1 §5/§D5. */
  collabLifecycleVersion?: number;
}

export interface OnAuthenticateDeps {
  wsTokenUtil: CollabWsTokenUtil;
  models: Pick<CollabModels, 'Page'>;
  /**
   * Defaults to the api-side cap check (currently `peek`-based via
   * Redis; falls back to readonly:false when Redis is unconfigured).
   * Phase 6 introduces `editorCapCounter` for the *write-side*
   * defence-in-depth — `checkEditorCap` is kept here so the contract
   * with `routes/ts-rest/page-collab.ts` (api-side) stays symmetric.
   */
  checkEditorCap?: typeof defaultCheckEditorCap;
  /**
   * Phase 6 — Redis-backed cap counter used to actually SADD an entry
   * on the websocket handshake (post-token-verify, post-page-exists).
   * Defaults to a no-op counter so tests that don't care about cap
   * keep working without a Redis fixture; production injects the real
   * counter via `startCollabServer`.
   */
  editorCapCounter?: EditorCapCounter;
}

/**
 * Build the Hocuspocus `onAuthenticate` hook.
 *
 * Order of checks is intentional: cheapest first, DB last, so a flood
 * of bogus tokens never hits Mongo.
 *
 *   1. token presence — reject "no token at all" outright.
 *   2. token signature + standard claims — `verifyWsToken` returns
 *      `null` on any failure (expired / bad signature / wrong issuer /
 *      malformed claims) per Phase 2's contract.
 *   3. token.pageId === documentName — the client provides documentName
 *      through the wire protocol (`HocuspocusProvider({ name })`); a
 *      mismatch would let a leaked readonly token be replayed against
 *      a different page. The pageId comparison is the only reason we
 *      include it inside the JWT body.
 *   4. Page exists — confirms the pageId isn't pointing at a deleted /
 *      never-existed document. We **do not** re-run the full
 *      `loadGrantedPage` permission re-check here: the wsToken is 5
 *      minutes long and was already gated by the api process.
 *   4a. RFC-0017 Phase 1 §5/§D5 — deleted-status reject: a page soft-
 *      deleted after the token was minted is rejected the same generic
 *      way as a missing page (no distinguishing message).
 *   4b. RFC-0017 Phase 1 §5/§D5/§16 PINNED — collab lifecycle epoch gate:
 *      `claims.epoch !== page.collabLifecycleVersion` is rejected
 *      (reject-and-remint). This is NOT an accept-with-fallback: a legacy
 *      pre-epoch token can't even reach this line (`WsTokenPayloadSchema`
 *      requires `epoch`, so `verifyWsToken` already returned `null` for it
 *      at step 2). This closes the rename/delete self-invalidation hole —
 *      a token minted BEFORE a lifecycle transition must never authenticate
 *      a load that would re-baseline the doc on the POST-transition state
 *      (RFC-0017 §0.1).
 *   4c. Draft author check (RFC-0004) — a `status: 'draft'` page is
 *      editable only by its author, so reject any connection whose
 *      `userId` doesn't match `Page.creator`. The api-side wsToken
 *      route applies the same gate at sign time; re-checking here
 *      closes the window where a token was minted before the page
 *      became a draft, or replayed across users.
 *   5. cap peek — the api-side `checkEditorCap` (Phase 6 promoted to
 *      a Redis `SCARD` read). The result `OR`s with the token's
 *      readonly bit so a cap-driven readonly never gets weakened.
 *   6. **Phase 6 acquire** — the *write*-side cap defence. When the
 *      token plus peek say "editable", we SADD `<userId>:<socketId>`
 *      into the Redis set and re-check the post-SADD count. A race
 *      (two clients passing peek simultaneously when only one slot
 *      remained) is resolved here: the loser observes acquired:false
 *      and is promoted to readonly. Readonly contexts skip the
 *      acquire entirely so they don't take a slot away from a real
 *      editor.
 *
 * Failure: throw with a generic message so the client sees
 * 'permission-denied' but never the precise reason (avoids token /
 * page leakage).
 */
export function createOnAuthenticate(deps: OnAuthenticateDeps) {
  const checkCap = deps.checkEditorCap ?? defaultCheckEditorCap;
  const editorCapCounter = deps.editorCapCounter ?? noopEditorCapCounter;

  return async (data: onAuthenticatePayload): Promise<CollabContext> => {
    const { documentName, token, requestParameters, socketId } = data;
    // Hocuspocus passes the connection token (`HocuspocusProvider({
    // token })`) into `data.token` directly, but some older providers
    // surface it as a query parameter — fall back so the AC's
    // `?token=...` URL form keeps working out-of-the-box.
    const presented = token && token.length > 0 ? token : (requestParameters.get('token') ?? '');
    if (presented.length === 0) {
      debug('reject: no token presented');
      throw new Error('authentication required');
    }

    const claims = deps.wsTokenUtil.verifyWsToken(presented);
    if (!claims) {
      debug('reject: wsToken verify failed');
      // §6 — prod-visible (sampled): a verify failure is the #1 cause of
      // the "closed before established" report (expired token / wrong or
      // unshared WS_TOKEN_SECRET across replicas / clock skew).
      sampledWarn(
        `onAuthenticate rejected a connection: wsToken verify failed for document ${String(documentName)} (expired / bad signature / secret mismatch / clock skew)`,
      );
      throw new Error('invalid token');
    }

    if (claims.pageId !== documentName) {
      debug('reject: token.pageId %s != documentName %s', claims.pageId, documentName);
      throw new Error('invalid token');
    }

    // RFC-0004: also pull `status` + `creator` so a draft page can be
    // gated to its author below. RFC-0017 Phase 1: also pull
    // `collabLifecycleVersion` for the epoch gate. `lean()` returns a
    // plain object, so `creator` is an ObjectId — compare via `String(...)`.
    const page = (await (deps.models.Page as DraftablePageModel)
      .findById(claims.pageId)
      .select('_id status creator collabLifecycleVersion')
      .lean()
      .exec()) as DraftablePageRow | null;
    if (!page) {
      debug('reject: page %s not found', claims.pageId);
      throw new Error('invalid token');
    }

    // RFC-0017 Phase 1 §5/§D5 — soft-deleted page: reject with the SAME
    // generic message as "page not found" (no leak of deleted-vs-missing).
    if (page.status === DELETED_STATUS) {
      debug('reject: page %s is deleted', claims.pageId);
      throw new Error('invalid token');
    }

    // RFC-0017 Phase 1 §5/§D5/§16 PINNED — collab lifecycle epoch gate:
    // reject-and-remint, never accept-with-fallback. `page.collabLifecycleVersion`
    // missing (pre-migration legacy row bypassing the schema default) reads
    // as `0`. Generic message — indistinguishable from any other invalid
    // token, so a caller can't probe whether the mismatch was due to a
    // rename/delete/revert vs. some other invalidity.
    const currentEpoch = resolvePageEpoch(page.collabLifecycleVersion);
    if (claims.epoch !== currentEpoch) {
      debug('reject: page %s epoch mismatch (token=%d, current=%d)', claims.pageId, claims.epoch, currentEpoch);
      throw new Error('invalid token');
    }

    // Draft author gate — `creator` may be absent on legacy rows; only
    // a `draft` status triggers the check, and published / null status
    // pages flow through untouched.
    if (page.status === DRAFT_STATUS && String(page.creator ?? '') !== claims.userId) {
      debug('reject: draft page %s not owned by user %s', claims.pageId, claims.userId);
      throw new Error('permission denied');
    }

    const cap = await checkCap(claims.pageId);
    let readonly = Boolean(claims.readonly) || Boolean(cap.readonly);

    // Phase 6 — only attempt the write-side cap acquire when we still
    // think this connection is editable. Readonly connections (token
    // bit set, or peek already said cap-reached) must NOT take a slot
    // — they live-subscribe but never write.
    if (!readonly) {
      const result = await editorCapCounter.tryAcquire(claims.pageId, claims.userId, socketId);
      if (!result.acquired) {
        debug('cap-exceeded on acquire (count=%d cap=%d) — promoting to readonly', result.count, result.cap);
        // §6 — prod-visible (sampled): a cap-driven readonly is the
        // benign explanation for "I can't type" reports — distinct from
        // a token failure. Surfacing it sampled lets an operator tell
        // "page is full (20+ editors)" apart from an auth problem.
        sampledWarn(`onAuthenticate promoted a connection to readonly: editor cap reached for page ${claims.pageId} (count=${result.count} cap=${result.cap})`);
        readonly = true;
      } else {
        debug('cap acquired page=%s user=%s socket=%s count=%d', claims.pageId, claims.userId, socketId, result.count);
      }
    }

    debug('accept: user=%s page=%s readonly=%s', claims.userId, claims.pageId, readonly);

    // Hocuspocus also looks at `connectionConfig.readOnly`; mutate the
    // payload so the message router enforces readonly at the protocol
    // layer (defence-in-depth on top of the context flag we return).
    data.connectionConfig.readOnly = readonly;

    return {
      userId: claims.userId,
      pageId: claims.pageId,
      readonly,
      // RFC-0017 Phase 1 — pinned for this connection's lifetime. `onChange`
      // compares it against the doc-level epoch store (which a fresh
      // `onLoadDocument` for a NEW materialisation overwrites) to detect a
      // stale, drain-detached connection best-effort. `claims.epoch ===
      // currentEpoch` is guaranteed here (the gate above already rejected
      // any mismatch), so either value would do — using `currentEpoch`
      // (server-read) rather than echoing `claims.epoch` back.
      epoch: currentEpoch,
    };
  };
}
