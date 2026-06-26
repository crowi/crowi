# @crowi/plugin-mail-smtp

## 0.1.0-alpha.1

### Patch Changes

- ff63cd1: Declare an explicit `zod` peer dependency range (`^4`) instead of `catalog:`. pnpm does not resolve the `catalog:` protocol inside `peerDependencies` during a workspace/source install, so building Crowi from source emitted a spurious `unmet peer zod@catalog:` warning for every plugin. Published packages were already correct (pnpm rewrites `catalog:` to a concrete range on publish), so npm consumers were unaffected — this only silences the noisy source/Docker-build install. Declaring `^4` also more honestly states that the plugins are compatible with any zod 4.x the host application provides.
- f1c9eed: Bump `nodemailer` to `^9.0.1` to clear two high-severity Dependabot advisories. The `createTransport` / `sendMail` surface the SMTP sender uses is unchanged across the 8 → 9 major (verified by type-check, build, and a `jsonTransport` runtime smoke). nodemailer 9 requires Node 20+, which Crowi already mandates.
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
