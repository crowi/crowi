---
'@crowi/api': minor
'@crowi/api-contract': minor
'@crowi/web': minor
'@crowi/cli': patch
---

Attachment uploads now share a single 50 MB size limit across the "Attach file" button, editor paste, and drag-and-drop — previously these disagreed (100 MB / 10 MB / 50 MB respectively), and the paste limit in particular did nothing to bound memory usage since the request body was already fully buffered before it was checked. Operators can lower the limit with the new `CROWI_UPLOAD_MAX_BYTES` environment variable (a value above 50 MB is clamped to 50 MB, since the limit is also the per-upload memory budget); see the environment variables table in the configuration docs. `GET /attachments/upload-policy` now reports this single limit as `maxBytes.attachment` (the separate `paste`/`dnd` figures are gone), and the editor upload request no longer sends an `intent` field — the web drag-and-drop handler now reads its size ceiling from this policy response instead of a hard-coded constant. If a reverse proxy sits in front of crowi and rejects an upload with its own (smaller) body-size limit before the request reaches the api, the web editor and the `crowi attach add` CLI command now recognize that the rejection didn't come from crowi itself and tell the user to check the proxy configuration instead of reporting crowi's own limit; the deployment docs gained a section on setting the proxy's body-size limit (nginx defaults to 1 MB) to a margin above crowi's own limit, since an exact match can still reject a request crowi would have accepted.
