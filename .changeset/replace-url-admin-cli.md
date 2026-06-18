---
'@crowi/admin-cli': minor
'@crowi/api': minor
---

Add `crowi-admin replace url --from <url> --to <url>` for swapping a literal
URL/host string in every page body — the fix for a v1→v2 migration that changed
the public domain and left absolute URLs (image embeds / links) pinned to the
old host. Page / file ids are carried over unchanged, so this is a literal host
swap, not an id remap.

Each match is rewritten as a new revision (auditable + revertable) while the
page's `updatedAt` / `lastUpdateUser` / `grant` are left untouched and no
`pageEvent` is emitted — so a bulk cleanup does not reorder "recently updated",
notify every watcher, or auto-watch the operator onto every page. The Yjs
snapshot is invalidated so collaborative editors rebuild from the new body.
Supports `--dry-run`, an interactive preview/confirmation (`--yes` to skip),
`--include-trash`, `--user <email>` (new-revision author; defaults to the oldest
admin), and a footgun guard that refuses an empty / too-short / scheme-less
`--from` (a bare host can corrupt longer hosts that start with it) unless
`--force` is given. After a run, rebuild the search index with
`crowi-admin rebuild search`; page rendering is already up to date.
