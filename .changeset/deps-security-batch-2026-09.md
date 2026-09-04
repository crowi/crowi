---
'@crowi/plugin-renderer-mermaid': patch
'@crowi/svg-sanitize': patch
'@crowi/plugin-api': patch
---

Update `@xmldom/xmldom` to 0.9.12, which fixes an XML fragment injection through an invalid `EntityReference.nodeName` during well-formed serialisation. Crowi reaches this parser from the SVG sanitiser and from the Mermaid renderer, both of which process content that users author, so the fix closes a path that untrusted input could otherwise take.
