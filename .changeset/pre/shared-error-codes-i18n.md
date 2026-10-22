---
"@crowi/api-contract": minor
---

Introduce a shared error-code contract so the server returns stable identifiers and the web app localizes them.

`@crowi/api-contract` now ships an `ErrorCode` ledger (`ERROR_CODES` / `ErrorCodeSchema` / `type ErrorCode`) and `ApiErrorSchema.error.code` is typed as `ErrorCodeSchema` instead of a free-form string. Every modern Hono handler now returns an `ErrorCode`, so the API can only emit known codes, and the web app maps each code to a paraglide message through an exhaustive `Record<ErrorCode, MessageFn>` — adding a code without a localization is a compile error. The me and public auth forms (login / register / reset-password / invite accept) route their error display through this helper, so localized copy replaces the raw English server message. Because `@crowi/api-contract` is in a linked group, `@crowi/api` and `@crowi/web` bump together. Mail i18n (recipient `User.lang`) is unchanged, and the legacy `status:'error'` envelope is left as-is.
