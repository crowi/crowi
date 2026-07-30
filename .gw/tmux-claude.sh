#!/usr/bin/env bash
# Launch a Claude Code session in a new tmux window for a gw worktree, with
# Remote Control enabled and a "<repo>:<id>" display name.
#
# Why: a kickoff'd worktree session sometimes stalls waiting on a question.
# Naming the session "<repo>:<id>" (e.g. crowi:live-page-sync-reconcile) makes
# it findable in the session picker / terminal title, and --remote-control lets
# it be driven remotely to unstick it. Called from ~/.gwrc post_start_hook /
# post_checkout_hook in place of the previous inline `tmux new-window ... claude`.
#
# Set GW_TMUX_CLAUDE_DRYRUN=1 to print the tmux command instead of running it.
set -u

wt="${GW_WORKTREE_PATH:?GW_WORKTREE_PATH not set}"
br="${GW_BRANCH_NAME:-$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)}"

# repo = basename of the MAIN worktree (git worktree list's first line), so
# every linked worktree of the same repo shares the prefix. Fall back to the
# worktree dir basename if git can't answer.
repo="$(basename "$(git -C "$wt" worktree list 2>/dev/null | head -1 | awk '{print $1}')" 2>/dev/null)"
[ -z "$repo" ] && repo="$(basename "$wt")"

# id = branch without the "/impl" suffix and the "feature-" prefix.
id="${br%/impl}"
id="${id#feature-}"
[ -z "$id" ] && id="$br"

name="${repo}:${id}"

# Window name = branch without the "/impl" suffix. Every worktree branch ends in
# "/impl", so the suffix carries no information while eating 5 columns of a tab
# bar that already truncates long feature names. Branches without the suffix
# (e.g. a plain `gw checkout`) keep their name as-is.
#
# Nothing keys off this name: crowi-kickoff locates the window by
# pane_current_path, and integrate-worktree's Step 6.5 does the same. Renaming a
# live window is therefore safe.
winname="${br%/impl}"
[ -z "$winname" ] && winname="$(basename "$wt")"

if [ "${GW_TMUX_CLAUDE_DRYRUN:-0}" = "1" ]; then
  printf 'tmux new-window -c %q -n %q -- claude --remote-control %q --name %q\n' "$wt" "$winname" "$name" "$name"
  exit 0
fi

exec tmux new-window -c "$wt" -n "$winname" "claude --remote-control '$name' --name '$name'"
