---
'@crowi/collab': patch
---

Fix v1-era pages getting corrupted when opened in the collaborative editor.
Revision bodies were seeded into the Y.Text verbatim, but Crowi v1 saved
bodies with CRLF (`\r\n`) line endings while CodeMirror 6 strips every `\r`
when it builds its document. That left the Y.Text one character longer per
line than the editor's view, and because y-codemirror.next maps positions
1:1 between them, every subsequent edit landed at the wrong offset and
progressively mangled the document (worse toward the end of the page).

The `onLoadDocument` body seed now normalizes CRLF / lone CR to LF before
inserting into the Y.Text, keeping it length-aligned with the editor.
Markdown rendering is line-ending agnostic, so this is a no-op for
already-LF (v2-authored) bodies. Pages that were already corrupted by a
prior edit must be restored from a pre-corruption revision.
