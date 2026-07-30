---
'@crowi/api': patch
---

Fix profile pictures disappearing a few minutes after upload on the S3
storage driver. The upload handler persisted a *time-limited signed* S3
URL (5-minute TTL) into `user.image` and served it verbatim, so the
avatar 403'd once the signature expired. Profile pictures now store the
stable `by-key` streaming-proxy path (`/api/attachments/by-key/...`)
regardless of driver — it never expires and is reachable from an
`<img>` via the access-token cookie. Existing avatars uploaded before
this fix need to be re-uploaded to pick up the stable form.
