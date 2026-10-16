#!/usr/bin/env bash
# ci-watch.sh — wait for every GitHub Actions run of one pushed commit and
# report how each ended. Meant to run as a background Bash command right after
# a push, so the session is woken once, when CI has an answer.
#
# Runs are looked up by the FULL commit SHA: `gh run list --commit` matches
# only the 40-character form and returns nothing for an abbreviated one, which
# a hand-written poll loop then waits on forever. Finding no run at all within
# CI_WATCH_APPEAR_TIMEOUT is therefore an error, never a reason to keep waiting.
#
# Output: one line per run, `<workflow> <conclusion> <run id>`.
# Exit:   0 every run succeeded (or was skipped)
#         1 at least one run failed / was cancelled
#         2 no run appeared, or the ref does not resolve
#
# Usage: ci-watch.sh [<ref>]          (default HEAD)
# Env:   CI_WATCH_APPEAR_TIMEOUT (seconds to wait for runs to appear, default 600)
#        CI_WATCH_SETTLE (seconds runs must stay unchanged in number before
#        watching, so a workflow that starts late — e.g. one chained by
#        workflow_run — is not missed; default 90)
#        CI_WATCH_INTERVAL (poll / watch interval in seconds, default 30)
set -u

ref="${1:-HEAD}"
sha="$(git rev-parse --verify --quiet "${ref}^{commit}")" || {
  echo "ci-watch: cannot resolve ${ref} to a commit" >&2
  exit 2
}
appear_timeout="${CI_WATCH_APPEAR_TIMEOUT:-600}"
settle="${CI_WATCH_SETTLE:-90}"
interval="${CI_WATCH_INTERVAL:-30}"

run_ids() {
  gh run list --commit "$sha" --limit 50 --json databaseId --jq '.[].databaseId' 2>/dev/null | sort -n
}

waited=0
ids="$(run_ids)"
while [ -z "$ids" ]; do
  if [ "$waited" -ge "$appear_timeout" ]; then
    echo "ci-watch: no workflow run appeared for ${sha} within ${appear_timeout}s" >&2
    exit 2
  fi
  sleep "$interval"
  waited=$((waited + interval))
  ids="$(run_ids)"
done

# Workflows chained after another one finishes start later; wait until the set
# of runs has stopped growing for `settle` seconds, and pick up any new one
# again after the known ones finish.
watched=""
while :; do
  stable=0
  while [ "$stable" -lt "$settle" ]; do
    sleep "$interval"
    next="$(run_ids)"
    if [ "$next" = "$ids" ]; then
      stable=$((stable + interval))
    else
      ids="$next"
      stable=0
    fi
  done
  pending=""
  for id in $ids; do
    case " $watched " in *" $id "*) ;; *) pending="$pending $id" ;; esac
  done
  [ -z "$pending" ] && break
  for id in $pending; do
    gh run watch "$id" --interval "$interval" >/dev/null 2>&1
    watched="$watched $id"
  done
  ids="$(run_ids)"
done

status=0
for id in $watched; do
  line="$(gh run view "$id" --json workflowName,conclusion --jq '"\(.workflowName) \(.conclusion)"')"
  echo "$line $id"
  case "${line##* }" in
    success | skipped | neutral) ;;
    *) status=1 ;;
  esac
done
exit "$status"
