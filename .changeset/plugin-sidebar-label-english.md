---
'@crowi/plugin-storage-local': patch
'@crowi/plugin-renderer-crowi-legacy': patch
---

Use English admin sidebar labels for the local-storage and Crowi-v1 renderer
plugins. Their `adminPlacement.label` was hardcoded in Japanese ("ローカルストレージ"
/ "Crowi v1 互換レンダラー") and showed even in the English admin UI; the sidebar
label has no per-locale mechanism, so this aligns them with every other plugin
(AWS S3, MongoDB, Elasticsearch, …) which already use neutral English labels.
