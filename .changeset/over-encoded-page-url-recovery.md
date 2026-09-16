---
'@crowi/web': patch
---

Open the right page when a shared link arrives percent-encoded twice. A page path may contain spaces, and Crowi's own links write a space as `+`; both `+` and `%20` read back as a space. But a link that passes through a tool which re-encodes an already-encoded URL arrives with its escapes escaped — `%2520` instead of `%20` — and one decode leaves the four literal characters `%20` sitting in the middle of the path. Crowi looked that up as a page name, found nothing, and offered to create an empty page while the real one sat a keystroke away. Now, once the literal path has missed, Crowi decodes once more and, if a page exists at the result, sends you there with the usual "redirected from" note, carrying any requested revision along. A page genuinely named with a `%` escape is unaffected: its own lookup succeeds first and the recovery never runs.
