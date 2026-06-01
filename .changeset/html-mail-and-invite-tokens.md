---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/web": minor
---

Add HTML email templates (MJML) and token-based invitations.

Transactional emails are now branded, responsive HTML built with MJML
and rendered by the core MailService (sender plugins still only deliver
the finished message). Email copy is localized to the recipient's
language (en / ja), and each message ships both an HTML and a plain-text
part.

Invitations are reworked to be secure: instead of emailing a plaintext
temporary password, an admin invite now sends a signed, expiring
invite-link. The invitee lands on a public `/invite/accept?token=…`
page, chooses their own username / name / password, and is signed in on
acceptance (account flips from invited to active). The invite token uses
the same JWT scheme as the WebSocket tokens (`WS_TOKEN_SECRET`,
per-purpose claims).

Activation (registration email confirmation) and self-service password
reset ship their MJML templates and localized copy in this release; their
end-to-end flows land in a follow-up.

BREAKING: invite emails no longer contain a temporary password — invited
users set their own credentials via the invite link.
