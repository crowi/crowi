---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Require email confirmation for self-registration.

When a user signs up themselves (open registration), the account is no
longer activated immediately. Registration now creates a pending account
and emails a signed activation link (localized MJML template); the public
`/activate?token=…` page confirms the address via `POST /auth/activate`
and signs the user in. Login is blocked with an "email not confirmed"
message until then.

Accounts created by an admin invite, by the installer, or by an admin
are treated as already confirmed (the invite link itself proves email
control), so those flows are unchanged. Restricted-registration mode
still gates on admin approval.

BREAKING: `POST /auth/register` no longer returns auth tokens; it returns
`{ status: 'confirmation_required' | 'approval_required' }` and the user
must confirm their email (or await approval) before signing in.
