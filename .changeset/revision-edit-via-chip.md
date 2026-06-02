---
"@crowi/api": minor
"@crowi/web": minor
---

Record and surface the edit channel of each page revision. Revisions now
carry an `editVia` field (`web` / `oauth` / `pat`) set from the request's
auth context, and the page history view shows an "app" chip with a tooltip
("Updated via the API using an OAuth token") next to the author for edits
made through the API with an OAuth access token or a personal access token.
Browser / collaborative-editor revisions are unaffected (no chip).
