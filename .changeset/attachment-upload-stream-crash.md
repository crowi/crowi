---
'@crowi/api': patch
---

Fix a crash where uploading an attachment or profile picture could bring down the entire api process instead of just failing that one request. The bug triggered whenever the active storage driver rejected the upload before consuming the file stream (for example, an S3 storage backend with no bucket configured) — the abandoned stream's later internal error had no listener attached, and an unhandled stream error is fatal to the whole Node process. Uploads now always attach an error handler and release the stream up front, so a misconfigured or failing storage driver produces a normal failed-upload response instead of an outage.
