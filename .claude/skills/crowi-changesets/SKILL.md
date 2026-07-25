---
name: crowi-changesets
description: >-
  changeset を追加するかどうかの判断基準・bump level (patch/minor/major) の選び方・
  対象パッケージの選び方・コマンド。feature や fix を commit する直前、
  「これ changeset いる?」と迷ったとき、リリースノートに載る文面を書くときに読む。
  キーワード: changeset, リリースノート, changelog, bump, patch, minor, major,
  pnpm changeset add, リリース準備
---

# Crowi changesets (release notes accumulation)

`@changesets/cli` is set up (Phase 9). Throughout v2 development, accumulate a `.changeset/*.md` per release-worthy change with `pnpm changeset add`, so the release notes for 2.0.0-alpha1 / stable are generated automatically from the past changes.

Write changeset bodies in English too (like commit messages, they go straight into the release notes), even when the working conversation is in Japanese.

When to add — one changeset per "unit of user value":
- ✅ Feature / bug fix / breaking change → one changeset.
- ✅ One feature split across several commits is still one changeset if it's a single thing from the user's point of view (do not add a changeset per small in-progress commit).
- ❌ Internal refactor / cleanup / lint fix / format / build infra / tests only → no changeset (no user-visible change).
- ❌ docs(todo) / CLAUDE.md / `.claude/` updates → no changeset.
- ❌ Per-phase commits of `feature-monorepo-packages-restructure` → covered as a whole by one changeset (`.changeset/initial-release.md`).

Rule of thumb: "is it worth writing in the next changelog?" Add when `feat:` / `fix:` changes user behavior; skip when it is only `refactor:` / `chore:` / `test:` / `docs:`.

Choosing the bump level:
- `patch` — bug fix, an internal optimization that becomes observable, dependency bump (semver-safe).
- `minor` — new feature, new endpoint, backward-compatible config addition.
- `major` — breaking change (API removal, endpoint contract change, newly-required config).

Choosing the target package:
- Changed API behavior → `@crowi/api`.
- Changed Web UI → `@crowi/web` (private, so it is never published, but a CHANGELOG.md is still generated).
- Changed an API contract → `@crowi/api-contract` (linked group, so api / web bump together).
- Extended the plugin SDK → `@crowi/plugin-api` + the affected individual plugins.
- Updated a single plugin → that plugin only.

Commands:
```bash
pnpm changeset add        # interactively pick package + bump level + summary
pnpm changeset status     # list accumulated, unreleased changesets
```

Add one file just before merging to main (or within the PR). The initial `.changeset/initial-release.md` is a sentinel covering the whole restructure, placed when `feature-monorepo-packages-restructure` completed — do not delete it.

なお changeset の summary は hard-wrap しない (1 段落 1 行)。GitHub Release / Version PR が GFM でレンダリングするため、改行が `<br>` になって読みにくくなる。commit message は従来どおり折る。
