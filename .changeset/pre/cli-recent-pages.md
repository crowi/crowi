---
"@crowi/cli": minor
"@crowi/api": minor
"@crowi/api-contract": minor
---

Add `crowi recent` to list the pages you can read in order of last update, newest first, without a search query or a search plugin. `--prefix <path>` narrows the list to pages whose path literally starts with the given text (case-sensitive, no regular expressions), and `--limit` / `--offset` page through it. The list endpoint `GET /api/pages/list` gains the matching `path_prefix` query and an `appliedPathPrefix` response field; the CLI refuses to print a prefix result the server did not confirm, so an older server fails clearly instead of returning an unfiltered list.
