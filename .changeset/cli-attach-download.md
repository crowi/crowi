---
'@crowi/api': patch
'@crowi/cli': patch
---

`crowi attach download <id>` downloads one attachment — to a file with `-o`, or to stdout so it can be piped. `crowi attach list` now prints the attachment id at the start of each row, which is what the new command takes. It is served by a new `GET /api/attachments/{id}/download`, a strict counterpart to the delivery routes an embedded `<img>` uses: those answer a missing attachment with the placeholder image and a `200`, which a client extracting bytes cannot tell apart from the real file, whereas this route returns `404` for both a missing record (`ATTACHMENT_NOT_FOUND`) and a missing stored object (`FILE_MISSING`). The CLI also validates the response before writing anything, and removes a partial file if the transfer is cut short, so a saved file is always the whole attachment.
