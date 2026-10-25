#!/usr/bin/env bash
# pr-merge-watch.sh — wait until one pull request is merged or closed. Meant to
# run as a background Bash command after a release Go/No-Go, because the
# Version PR is often merged by hand on GitHub and the session would otherwise
# not learn of it until someone says so.
#
# Output: `MERGED <merge commit sha>` or `CLOSED` (one line).
# Exit:   0 merged
#         1 closed without merging
#         2 the PR cannot be read (bad number, gh unavailable or not signed in)
#
# Usage: pr-merge-watch.sh <pr number>
# Env:   PR_MERGE_WATCH_INTERVAL (poll interval in seconds, default 60)
set -u

pr="${1:-}"
[ -n "$pr" ] || { echo "usage: pr-merge-watch.sh <pr number>" >&2; exit 2; }
interval="${PR_MERGE_WATCH_INTERVAL:-60}"

failures=0
while true; do
  if out="$(gh pr view "$pr" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid // "")"' 2>/dev/null)"; then
    failures=0
    read -r state sha <<<"$out"
    case "$state" in
      MERGED) echo "MERGED $sha"; exit 0 ;;
      CLOSED) echo "CLOSED"; exit 1 ;;
    esac
  else
    # A single failed call is usually a network blip; ten in a row means the
    # PR or gh itself is unusable, and waiting on it would never end.
    failures=$((failures + 1))
    [ "$failures" -lt 10 ] || { echo "pr-merge-watch: cannot read PR #$pr" >&2; exit 2; }
  fi
  sleep "$interval"
done
