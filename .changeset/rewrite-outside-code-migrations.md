---
'@crowi/api': patch
---

Fix a data-corruption hazard in the `files-url-to-attachments` and `wikilink-html-recover` preflight migrations: a `/files/<id>` URL or a `[[/font]]` token written as a code example (inside a fenced code block or an inline code span) is no longer rewritten. Previously only `wikilink-format` excluded code regions; the other two migrations would corrupt such code examples (e.g. rewrite `![pic](/files/<id>)` shown in documentation, or revert a `[[/font]]` written to explain the migration) and could falsely report the migration as pending — which, under preflight + the `block` policy, could keep cluster boot deadlocked forever. All three body-rewrite migrations now route their detection and rewrite through a single shared `rewriteOutsideCode` code-mask primitive, so they behave identically: code regions are passed through byte-for-byte and a page whose only target token lives inside code is correctly reported as not pending.
