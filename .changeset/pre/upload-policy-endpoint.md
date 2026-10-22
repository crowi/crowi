---
"@crowi/api-contract": minor
"@crowi/api": minor
"@crowi/cli": minor
---

The server now publishes its upload policy at `GET /attachments/upload-policy` (allowed MIME types, extension-to-MIME hints, and per-route size limits), so clients no longer have to guess what an instance accepts. `@crowi/cli`'s `attach add` fetches (and caches per profile) this policy before uploading and rejects an oversized file or a disallowed type locally, instead of waiting for a 413/415 round trip; against an older server that lacks the endpoint (404), it falls back to its built-in extension table exactly as before, so nothing regresses. Profile picture uploads (`POST /me/picture`) now resolve the effective MIME type from the filename when the client doesn't declare a `Content-Type` (the same fallback already used by attachment uploads), so CLI, curl, and MCP clients can finally set a profile picture without declaring one. Profile picture acceptance also moves from an unbounded `image/*` pattern to the same finite image-type allow-list attachments use, plus a 5MB size cap matching the web client's existing crop-dialog guard; a declared `image/*` type outside that list (e.g. `image/tiff`) or a file over 5MB is now rejected, which it previously was not.
