---
'@crowi/api': patch
---

Fix a stored cross-site-scripting hole in attachment delivery. An attachment's content type was taken from the uploading client's own declaration and echoed back with `Content-Disposition: inline`, so a user with edit rights could upload an HTML (or SVG) file and have it execute on the wiki's origin when someone opened its link, exposing that visitor's session token. Attachment delivery now pins the outgoing content type to an allowlist of types that render safely — images, PDF and plain text — and serves anything else as a download, and every API response carries `X-Content-Type-Options: nosniff`. The check runs at delivery time, so attachments already stored with a hostile content type are covered too. Note that uploaded SVG files are now downloaded rather than displayed inline, because they can carry scripts and are not sanitized.
