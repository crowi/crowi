---
'@crowi/api-contract': patch
'@crowi/api': patch
'@crowi/web': patch
---

Narrow `User.lang` to the live `en` / `ja` locales. The legacy regional
variants (`en-US` / `en-GB`) were retired — only `en` and `ja` ship UI
messages — so the language enum (`LanguageSchema` / `UserLanguageSchema`),
the Mongoose enum, and the `User.lang` type are all tightened to `en` / `ja`,
and the new-user default moves from `en-US` to `en`.

Existing rows that still hold a legacy value are handled without a data
migration: they are normalised to `en` on read (`GET /me`) and coerced on
write via a `User` `pre('validate')` hook, so the tightened enum never
rejects a save. Also fixes a latent copy-paste bug where the `User.LANG_EN_GB`
model static was assigned the `en-US` value.
