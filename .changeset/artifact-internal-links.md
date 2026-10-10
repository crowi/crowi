---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Artifact pages can now link to other wiki pages with ordinary `a` / `area` links (absolute, relative to the artifact's own page, or with a `#fragment`): a normal click or Enter moves the wiki to the page in the same tab, cmd/ctrl-click and `target="_blank"` open a new tab, and the wiki only follows links to regular wiki pages while the reader is actually interacting with the artifact, asking for confirmation instead when the link was activated right after the page opened or after the reader acted on the page around the artifact.
