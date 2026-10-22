---
'@crowi/api': patch
---

Fix a stored cross-site-scripting hole in attachment delivery. An attachment's content type was taken from the uploading client's own declaration and echoed back with `Content-Disposition: inline`, so a user with edit rights could upload an HTML file and have it execute on the wiki's origin when someone opened its link, exposing that visitor's session token. Attachment delivery now pins the outgoing content type to an allowlist of types that render safely, serves anything else as a download, sends `Content-Security-Policy: sandbox` with inline responses so an embedded document can neither run scripts nor reach the wiki's origin, and sets `X-Content-Type-Options: nosniff` on every API response. The check runs at delivery time, so attachments already stored with a hostile content type are covered too. Images, PDFs and text attachments — including SVG images embedded in pages — keep displaying as before.
