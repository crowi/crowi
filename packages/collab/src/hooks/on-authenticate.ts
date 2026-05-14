import type { onAuthenticatePayload } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabModels } from '../models';
import type { CollabContext } from '../types';
import type { CollabWsTokenUtil } from '../ws-token';
import { checkEditorCap as defaultCheckEditorCap } from '../collab-cap';

const debug = Debug('crowi:collab:auth');

export interface OnAuthenticateDeps {
  wsTokenUtil: CollabWsTokenUtil;
  models: Pick<CollabModels, 'Page'>;
  /**
   * Defaults to the in-process stub (`always { readonly: false }`).
   * The Phase 6 Redis implementation can replace this for the
   * defence-in-depth re-check that happens **after** the wsToken's
   * readonly bit is honoured.
   */
  checkEditorCap?: typeof defaultCheckEditorCap;
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
 *      minutes long and was already gated by the api process. Phase 6
 *      reliability will harden this further if operators want belt-
 *      and-braces.
 *   5. cap stub — Phase 2's `checkEditorCap` is the stub that always
 *      returns `{ readonly: false }`; Phase 6's Redis implementation
 *      slots in here. The result `OR`s with the token's readonly bit
 *      so a cap-driven readonly never gets weakened.
 *
 * Failure: throw with a generic message so the client sees
 * 'permission-denied' but never the precise reason (avoids token /
 * page leakage).
 */
export function createOnAuthenticate(deps: OnAuthenticateDeps) {
  const checkCap = deps.checkEditorCap ?? defaultCheckEditorCap;

  return async (data: onAuthenticatePayload): Promise<CollabContext> => {
    const { documentName, token, requestParameters } = data;
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
      throw new Error('invalid token');
    }

    if (claims.pageId !== documentName) {
      debug('reject: token.pageId %s != documentName %s', claims.pageId, documentName);
      throw new Error('invalid token');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = await (deps.models.Page as any).findById(claims.pageId).select('_id').lean().exec();
    if (!page) {
      debug('reject: page %s not found', claims.pageId);
      throw new Error('invalid token');
    }

    const cap = await checkCap(claims.pageId);
    const readonly = Boolean(claims.readonly) || Boolean(cap.readonly);

    debug('accept: user=%s page=%s readonly=%s', claims.userId, claims.pageId, readonly);

    // Hocuspocus also looks at `connectionConfig.readOnly`; mutate the
    // payload so the message router enforces readonly at the protocol
    // layer (defence-in-depth on top of the context flag we return).
    data.connectionConfig.readOnly = readonly;

    return {
      userId: claims.userId,
      pageId: claims.pageId,
      readonly,
    };
  };
}
