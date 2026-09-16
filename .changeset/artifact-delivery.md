---
"@crowi/api": minor
"@crowi/api-contract": minor
---

Add the HTTP surface that serves a stored HTML "artifact" page's bytes (RFC-0020): `POST /api/pages/{id}/artifact-url` mints a 60-second signed URL for a granted page's current (or a specified historical) artifact revision, `GET /api/artifact/{pageId}/{revisionId}` serves those bytes to that signed URL alone (no cookie, no session — the token is the only credential, and it is the endpoint an HTML artifact page's sandboxed preview will load from once later phases add that preview), and `GET /api/pages/{id}/artifact-download` downloads the same bytes as a plain attachment under normal session/PAT auth, working even when artifact delivery has not been configured on this server. The serve route's response carries the fixed security headers required to keep a served artifact from reaching Crowi's own origin, cookies, or API; the download route omits them deliberately, since it hands the bytes to the browser as a plain attachment rather than a document to render. Until later phases add the page shell that requests a delivery URL, this only changes what the API surface accepts and returns.
