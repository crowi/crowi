#!/usr/bin/env bash
# manager-watch.sh — one wake-up per real event for the manager session.
#
# Runs the agmsg inbox watcher (restricted to the `manager` role) and
# orchestrate-watch.sh --until-event together, and exits — printing what
# arrived — on the first line either of them produces. The caller starts it
# with the Bash tool's run_in_background, handles the event, and starts it
# again.
#
# Why not two Monitor watches: since Claude Code 2.1.271 a Monitor watch
# always expires (30 minutes at most; the no-timeout `persistent` option is
# gone) and every expiry wakes the model with nothing to act on. A background
# Bash command has no such deadline and notifies once, when it exits.
# orchestrate-watch.sh keeps its own record of what it has already reported,
# so restarting it does not replay known events; the agmsg watcher resumes
# from its own read cursor for the same reason.
#
# Usage: manager-watch.sh <claude-session-id>
set -u
SID="${1:?usage: manager-watch.sh <claude-session-id>}"
ROOT="${MANAGER_WATCH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
AGMSG_WATCH="${AGMSG_WATCH:-$HOME/.agents/skills/agmsg/scripts/watch.sh}"
POLL="${MANAGER_WATCH_POLL:-10}"

out="$(mktemp)"
"$AGMSG_WATCH" "$SID" "$ROOT" claude-code manager >>"$out" 2>/dev/null &
agmsg=$!
bash "$ROOT/.claude/scripts/orchestrate-watch.sh" --until-event >>"$out" 2>/dev/null &
orchestrate=$!

cleanup() {
  pkill -P "$agmsg" 2>/dev/null
  pkill -P "$orchestrate" 2>/dev/null
  kill "$agmsg" "$orchestrate" 2>/dev/null
  rm -f "$out"
}
# TERM/INT run the EXIT trap through `exit`, so a stopped watcher does not
# orphan its two children onto init (observed: month-old orphans still
# polling the GitHub API).
trap cleanup EXIT
trap 'exit 143' TERM INT

while :; do
  if [ -s "$out" ]; then
    # A moment for the rest of a burst (both watchers can emit at once) so one
    # wake-up carries everything that arrived.
    sleep 1
    grep -v -E '^[[:space:]]*$' "$out"
    exit 0
  fi
  if ! kill -0 "$agmsg" 2>/dev/null || ! kill -0 "$orchestrate" 2>/dev/null; then
    echo "WATCHER_EXITED: agmsg alive=$(kill -0 "$agmsg" 2>/dev/null && echo yes || echo no), orchestrate alive=$(kill -0 "$orchestrate" 2>/dev/null && echo yes || echo no)"
    exit 1
  fi
  sleep "$POLL"
done
