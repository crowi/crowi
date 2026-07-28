/**
 * Public email-change confirmation handler.
 *
 *   GET  /auth/confirm-email-change?token= — preflight (token valid?)
 *   POST /auth/confirm-email-change        — apply the new email address
 *
 * The user requests the change via `PUT /me` (which does not apply it);
 * the signed token (purpose `'email-change'`, payload `email` = new
 * address) is the credential here, so both routes are public.
 */
import { emailChangeRoutes } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { createMailTokenUtil } from 'src/util/mail-token';
import { mapDuplicateKeyError } from 'src/util/map-duplicate-key-error';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:emailChange');

const INVALID_TOKEN_BODY = {
  error: { code: 'INVALID_EMAIL_CHANGE_TOKEN' as const, message: 'Email-change link is invalid or expired' as const },
};

export const registerEmailChangeRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const User = crowi.model('User');
  const mailTokenUtil = createMailTokenUtil();

  return app
    .openapi(emailChangeRoutes.validateEmailChangeTokenRoute, async (c) => {
      const { token } = c.req.valid('query');
      const payload = mailTokenUtil.verifyMailToken(token, 'email-change');
      if (!payload) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      // Apply the same bindings the POST does. A well-signed link is not the
      // same thing as a usable one: it stays signature-valid for its whole 24h
      // TTL even after the address moved on or the requesting session was
      // revoked. Answering 200 there would show the confirmation page (and the
      // target address) for a link that the POST then refuses, making the
      // security transition look like a bug. The POST's conditional update
      // stays the authoritative, race-safe check — this is a precheck, and it
      // is fail-closed for the same reason the reset flow's is.
      const user = await User.findById(payload.userId);
      if (!user) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      if (payload.fromEmail && payload.fromEmail !== user.email) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      if (payload.authVersion === undefined || payload.authVersion !== (user.authVersion ?? 0)) {
        return c.json(INVALID_TOKEN_BODY, 401);
      }
      return c.json({ ok: true as const, email: payload.email }, 200);
    })
    .openapi(emailChangeRoutes.confirmEmailChangeRoute, async (c) => {
      const { token } = c.req.valid('json');

      try {
        const payload = mailTokenUtil.verifyMailToken(token, 'email-change');
        if (!payload) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        const user = await User.findById(payload.userId);
        if (!user) {
          return c.json({ error: { code: 'USER_NOT_FOUND' as const, message: 'User no longer exists' } }, 404);
        }

        // Single-use binding: the token carries the account's email at
        // issue time. If the address has since changed (already confirmed
        // once, or a newer request was made), this token is stale —
        // reject it so an old link cannot revert the address.
        if (payload.fromEmail && payload.fromEmail !== user.email) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        // A pending change must not outlive the session that requested it.
        // `fromEmail` alone does not achieve that: neither a password change
        // nor an admin reset touches `email`, so it still matches afterwards
        // — meaning an attacker who requested a change to their own address
        // before being evicted could confirm it after the eviction and take
        // the account's recovery address, undoing the recovery. Binding to
        // `authVersion` is exactly the semantics wanted ("the session that
        // asked for this is gone"), and every revocation event already moves
        // it. Links minted before this claim existed carry no `authVersion`
        // and are rejected outright rather than trusted.
        const tokenAuthVersion = payload.authVersion;
        if (tokenAuthVersion === undefined || tokenAuthVersion !== (user.authVersion ?? 0)) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        // The new address may have been claimed by someone else between
        // the request and the confirmation.
        const clash = await User.findOne({ email: payload.email });
        if (clash && clash._id.toString() !== user._id.toString()) {
          return c.json({ error: { code: 'EMAIL_TAKEN' as const, message: 'That email address is already in use' } }, 409);
        }

        // Apply conditionally rather than with `save()`: the checks above are
        // a read, and between them and the write the account can be reset,
        // have its address changed by another link, or be raced by a second
        // submission of this same one. Re-stating both bindings in the filter
        // makes the confirmation atomic with them — no match means something
        // moved underneath, which is the same 401 the checks would have given.
        const applied = await User.findOneAndUpdate(
          {
            _id: user._id,
            ...(payload.fromEmail ? { email: payload.fromEmail } : {}),
            // Legacy rows carry no `authVersion`; `null` matches those as
            // well as an explicit 0, which is what their links are bound to.
            authVersion: tokenAuthVersion === 0 ? { $in: [0, null] } : tokenAuthVersion,
          },
          { $set: { email: payload.email } },
          { returnDocument: 'after' },
        );
        if (!applied) {
          return c.json(INVALID_TOKEN_BODY, 401);
        }

        return c.json({ ok: true as const, email: applied.email }, 200);
      } catch (error) {
        // The email findOne pre-check can be raced; the unique index is the
        // final defence. Map its E11000 to the same 409 the pre-check returns.
        const duplicateCode = mapDuplicateKeyError(error);
        if (duplicateCode === 'EMAIL_TAKEN') {
          return c.json({ error: { code: 'EMAIL_TAKEN' as const, message: 'That email address is already in use' } }, 409);
        }
        debug('email-change confirmation error:', error);
        return c.json(INTERNAL_ERROR_BODY, 500);
      }
    });
};
