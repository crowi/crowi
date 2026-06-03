---
"@crowi/api": minor
---

Upgrade Mongoose from 6.x to 8.24.0 (API and the embedded collab library) and
replace the unmaintained `mongoose-paginate` with `mongoose-paginate-v2`.

This is a version-follow upgrade: behavior and the API/JSON contracts are
unchanged. The pagination result envelope rename (`total`→`totalDocs`,
`pages`→`totalPages`) is absorbed inside the admin handlers, so the
`/admin/users` pager JSON shape is identical to before. Model statics that
used Mongoose-6 callback queries (`save`/`find`/`exec`/`findById`/`updateOne`
callbacks, `Document#remove()`, `findOneAndRemove`, callback-form `connect`)
were migrated to the promise/async forms that Mongoose 7/8 require, while
keeping their public callback signatures so call sites are unaffected.
