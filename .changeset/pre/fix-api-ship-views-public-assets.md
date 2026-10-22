---
'@crowi/api': patch
---

Ship the `views/` mail templates and `public/` static assets in the published
`@crowi/api` package. The `files` field listed only `dist` + `README.md`, so
`pnpm deploy --prod` dropped `views/mail/*.{mjml,text}` and
`public/images/file-not-found.png` from the production Docker image's
`node_modules/@crowi/api/`. As a result every mail send (test / account
activation / admin-approval-pending / email change / user invitation /
password-change notification / password reset) failed at runtime with
`ENOENT` while resolving its template, and the attachment "file not found"
placeholder image likewise could not be streamed. Neither reproduced under
`pnpm dev`, where the full source tree is visible without going through
`node_modules`. Adding `views` and `public` to `files` fixes both.
