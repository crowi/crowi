---
'@crowi/api': minor
'@crowi/admin-cli': minor
---

Split the boot-time preflight migration probe by a new per-migration `severity` (`cosmetic` | `blocking`). A `cosmetic` migration (the display-only ones — the body-rewriting `wikilink-format` / `files-url-to-attachments` / `wikilink-html-recover` and the path-relocating `relocate-reserved-api-paths`) that is still pending now only logs a warning and lets the api boot — even under the default `block` policy — while the data-integrity `user-unique-prepare` migration stays `blocking` and still refuses boot under `block` (downgradeable with `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY=warn`). This fixes the deadlock where a newly written page in old wikilink syntax kept a cosmetic migration's corpus-scan probe pending forever and permanently refused the whole cluster's boot. `crowi-admin migrate list` / `migrate plan` now tag each preflight migration `[blocking]` / `[cosmetic]` so operators can judge boot-block risk (boot-layer rows, which are never boot-probed, show `—`).
