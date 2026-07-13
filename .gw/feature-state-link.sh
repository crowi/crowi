#!/bin/bash
# Single-source the SHARED parts of the /feature pipeline state across worktrees.
#
# `.feature-state/` is gitignored (it holds uncommitted spec/task/queue files
# for the new-feature workflow). It has two kinds of state:
#
#   - SHARED, per-id, read-mostly:  specs/{id}.md, tasks/{id}.json, config.json
#       A spec/task raised in one worktree should be visible everywhere, and
#       concurrent worktrees touch DIFFERENT id files, so sharing is safe.
#   - PER-WORKTREE, volatile singleton:  queue.json (currentTask / lastUpdated)
#       This is "what THIS worktree is doing now". Sharing it across parallel
#       worktrees corrupts it (every `/feature` run clobbers one `currentTask`).
#
# So this hook symlinks ONLY the shared parts into the new worktree and leaves
# `queue.json` local. (Previously it symlinked the whole directory, which made
# parallel `/feature` runs stomp each other's queue.json — the bug this fixes.)
#
# Symlink only — the claude/tmux launch stays in .gwrc, chained after this
# script with `&&` (see .gw/tmux-claude.sh).
#
# This is crowi's repo-local copy, invoked from the project-local .gwrc which
# derives the main worktree root from $GW_WORKTREE_PATH (so no ~ dependency):
#   post_start_hook = MAIN="$(git -C "$GW_WORKTREE_PATH" worktree list \
#     --porcelain | sed -n '1s/^worktree //p')" \
#     && "$MAIN/.gw/feature-state-link.sh" && "$MAIN/.gw/tmux-claude.sh"

set -euo pipefail

link="$GW_WORKTREE_PATH/.feature-state"

# First entry of `git worktree list` is always the main worktree.
main="$(git -C "$GW_WORKTREE_PATH" worktree list --porcelain | sed -n '1s/^worktree //p')"
src="$main/.feature-state"

# Opt-in: only act when the main worktree actually uses .feature-state.
# Repos without it (most projects don't use the /feature workflow) are left
# untouched. Idempotent: the per-item guards below skip already-linked items,
# and we also migrate an OLD whole-directory symlink to the new layout.
if [ -n "$main" ] && [ "$main" != "$GW_WORKTREE_PATH" ] && [ -d "$src" ]; then
  mkdir -p "$src/specs" "$src/tasks"

  # Migrate the legacy whole-directory symlink (`.feature-state -> main`).
  if [ -L "$link" ]; then
    rm -f "$link"
  fi
  mkdir -p "$link"

  # SHARED, per-id / read-only → symlink to the main store.
  [ -L "$link/specs" ] || { rm -rf "$link/specs"; ln -s "$src/specs" "$link/specs"; }
  [ -L "$link/tasks" ] || { rm -rf "$link/tasks"; ln -s "$src/tasks" "$link/tasks"; }
  if [ -f "$src/config.json" ]; then
    [ -L "$link/config.json" ] || { rm -f "$link/config.json"; ln -s "$src/config.json" "$link/config.json"; }
  fi

  # PER-WORKTREE volatile → a fresh local queue.json (NOT shared). Seed once.
  [ -e "$link/queue.json" ] || echo '{ "currentTask": null }' > "$link/queue.json"

  echo "[gw hook] linked .feature-state shared parts (specs/ tasks/ config.json); queue.json is worktree-local"
fi
