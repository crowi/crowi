# @crowi/collab

## 0.1.0-alpha.1

### Patch Changes

- 27ef287: Fix v1-era pages getting corrupted when opened in the collaborative editor.
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

- Updated dependencies [0e9a07c]
  - @crowi/api-contract@2.0.0-alpha.1

## 0.1.0-alpha.0

### Patch Changes

- Updated dependencies [8d8e04d]
- Updated dependencies [c7443c4]
- Updated dependencies [ce294dd]
- Updated dependencies [ad0cc9b]
- Updated dependencies [32f5965]
- Updated dependencies [9c55f6c]
- Updated dependencies [548e0c8]
- Updated dependencies [a52d03f]
- Updated dependencies [a0f4ada]
- Updated dependencies [966d133]
- Updated dependencies [e7296c0]
- Updated dependencies [ec00876]
- Updated dependencies [8f12462]
- Updated dependencies [637f0c9]
- Updated dependencies [deb6a26]
- Updated dependencies [ea2b7db]
- Updated dependencies [ee935ad]
- Updated dependencies [b8c067b]
- Updated dependencies [ab063fe]
- Updated dependencies [87f35d4]
- Updated dependencies [be5fcee]
- Updated dependencies [088f922]
- Updated dependencies [97e6543]
- Updated dependencies [10ac192]
- Updated dependencies [9899d5f]
- Updated dependencies [4594ad2]
  - @crowi/api-contract@2.0.0-alpha.0
