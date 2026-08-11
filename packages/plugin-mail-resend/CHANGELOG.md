# @crowi/plugin-mail-resend

## 0.1.0-alpha.3

### Minor Changes

- 0b2656a: BREAKING: `GET /admin/plugins/readiness`'s response shape changes from a plugin-only `{ name, adminPlacement, fields }` issue to a generic `{ id, source: 'plugin' | 'core', label, href, fields }` issue, so this admin-only endpoint's existing contract is not backward compatible for any client parsing the old field names. There is no server-side alias for the old shape. The endpoint path, auth (admin-only JWT), and the underlying "unset field" semantics are unchanged; `@crowi/web`'s own consumer of this endpoint is updated in the same release.

  Admin readiness now also covers core mail configuration, and test-send errors no longer leak internal details to the browser.

  - The `mail:from` sender address (a core setting, not a plugin one) now participates in the same admin readiness check that already covered storage/search plugin config: when it's unset, admins see it in the shared readiness banner (on every wiki page and `/admin/plugins`) with a link straight to `/admin/mail`.
  - `@crowi/plugin-mail-smtp` (`host`) and `@crowi/plugin-mail-resend` (`apiKey`) now declare `readiness` too, so an incomplete SMTP or Resend setup is caught the same way S3/Elasticsearch/OpenSearch already are. AWS SES intentionally declares none — its credentials fall back to the AWS SDK default credential chain, which is a legitimate empty configuration.
  - `mail:from` and the active mail driver's required fields are independent issues — either one being unset keeps mail flagged as not ready.
  - A test-send failure caused by an unset `mail:from` now returns a dedicated `MAIL_FROM_NOT_CONFIGURED` error with a localized explanation and a link back to mail settings, instead of a generic failure. Any other sender/transport failure (e.g. a connection error or bad credentials) is logged on the server only — the browser only ever sees a safe, localized generic message, never the raw exception text.

### Patch Changes

- Updated dependencies [9a06104]
  - @crowi/plugin-api@1.0.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- Updated dependencies [ff63cd1]
  - @crowi/plugin-api@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- 966d133: Make email delivery plugin-based.

  Email sending is now a pluggable transport. The core assembles every
  message (from / subject / rendered body) so it is identical regardless of
  which sender is active, and a mail sender plugin only delivers the
  finished message. The active sender is selected by
  `crowi.config.json:mail.driver` (default `smtp`), mirroring the storage
  and search single-active-driver model.

  - New `@crowi/plugin-mail-smtp` (default-on) delivers over SMTP via
    nodemailer.
  - New `@crowi/plugin-mail-resend` and `@crowi/plugin-mail-aws-ses`
    (depends on `@crowi/plugin-aws`) official senders.
  - New `registerMailSender` plugin hook + `MailSender` / `EmailMessage`
    contract in `@crowi/plugin-api`.
  - `/admin/mail` now owns only the sender-independent `from` address, shows
    the active sender, and sends a test mail through it; each sender's
    credentials are configured under `/admin/plugins`.

  BREAKING: the legacy `mail:smtp*` / `mail:aws:*` Config keys and the SMTP
  / SES fields of the `admin.mail` API are removed. SMTP credentials live in
  the `@crowi/plugin-mail-smtp` plugin config namespace instead.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
