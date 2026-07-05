#!/usr/bin/env bash
# orchestrate-watch.sh — event emitter for crowi-orchestrate's watch mode.
#
# Runs the WATCHER half of the orchestrate lanes in plain bash under a
# persistent Monitor, so the model spends zero tokens while nothing happens
# and wakes only on an actionable event (the anti-/loop: /loop burns a tick's
# tokens even when idle and sleeps through events).
#
# One line per event (the Monitor turns each into a notification):
#   READY_TO_INTEGRATE: <id>                          (lane A — act: verify + /integrate-worktree)
#   STALLED: <id> (<n> ahead, last commit <d>d ago)   (lane E — act: report only)
#   REVIEW_THRESHOLD: <n> impl commits since <sha>    (lane C — act: /crowi-review <sha>..main)
#   NEW_DEPENDABOT: #<num> <severity> <package>       (lane D — act: report; /crowi-deps is the fixer)
#
# Read-only by design: state files (.feature-state/orchestrate-state.json) are
# only READ here; the model updates them when it acts on an event (keeps the
# existing lane contracts unchanged). Dedup is in-memory per watcher lifetime —
# a restarted watcher may re-emit current facts once, which is safe (the model
# re-verifies before acting).
#
# Usage: orchestrate-watch.sh [--once]     (--once: single pass for testing)
# Env:   ORCH_WATCH_INTERVAL (default 60s), ORCH_STALL_DAYS (default 3),
#        ORCH_DEP_EVERY (dependabot check every Nth pass, default 30)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASKS="$ROOT/.feature-state/tasks"
STATE="$ROOT/.feature-state/orchestrate-state.json"
INTERVAL="${ORCH_WATCH_INTERVAL:-60}"
STALL_DAYS="${ORCH_STALL_DAYS:-3}"
DEP_EVERY="${ORCH_DEP_EVERY:-30}"
ONCE=0; [ "${1:-}" = "--once" ] && ONCE=1

seen_ready="" seen_stall="" seen_review="" seen_dep=""
has() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

pass=0
while true; do
  # ---- lane A: READY_TO_INTEGRATE signals (status via jq, not grep — history
  # entries also contain the literal string) --------------------------------
  for f in "$TASKS"/*.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.status // empty' "$f" 2>/dev/null)" = "READY_TO_INTEGRATE" ] || continue
    id="$(basename "$f" .json)"
    has "$id" "$seen_ready" || { echo "READY_TO_INTEGRATE: $id"; seen_ready="$seen_ready $id"; }
  done

  # ---- lane E: stalled worktrees (commits ahead, no/stale signal, old) -----
  # NOTE: heredoc (not a pipe) so the loop runs in THIS shell — a piped
  # `while read` is a subshell and would lose the seen_* dedup updates.
  while read -r wt; do
    [ -n "$wt" ] || continue
    [ "$wt" = "$ROOT" ] && continue
    id="$(basename "$wt")"; id="${id#crowi-}"
    head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || continue
    n="$(git -C "$wt" rev-list --count main..HEAD 2>/dev/null || echo 0)"
    [ "$n" -gt 0 ] || continue
    sig="$(jq -r '.readyForMerge.headSha // empty' "$TASKS/$id.json" 2>/dev/null)"
    [ "$sig" = "$head" ] && continue                       # fresh signal → lane A's job
    last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
    age_d=$(( ($(date +%s) - last) / 86400 ))
    [ "$age_d" -ge "$STALL_DAYS" ] || continue
    key="$id:$head"
    has "$key" "$seen_stall" || { echo "STALLED: $id ($n ahead, last commit ${age_d}d ago, no fresh signal)"; seen_stall="$seen_stall $key"; }
  done <<EOF
$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF

  # ---- lane C: main direct-work review threshold ---------------------------
  base="$(jq -r '.lastReviewedMainSha // empty' "$STATE" 2>/dev/null)"
  if [ -n "$base" ] && git -C "$ROOT" rev-parse -q --verify "$base" >/dev/null 2>&1; then
    mainhead="$(git -C "$ROOT" rev-parse main 2>/dev/null)"
    if [ "$mainhead" != "$base" ] && ! has "$mainhead" "$seen_review"; then
      # impl commits = first-parent non-merge commits touching packages/** source
      cnt=0
      while read -r sha; do
        [ -n "$sha" ] || continue
        if git -C "$ROOT" show --name-only --format= "$sha" 2>/dev/null | grep -q '^packages/'; then
          cnt=$((cnt + 1))
        fi
      done <<EOF
$(git -C "$ROOT" log --first-parent --no-merges --format=%H "$base..main" 2>/dev/null)
EOF
      if [ "$cnt" -ge 2 ]; then
        echo "REVIEW_THRESHOLD: $cnt impl commits on main since ${base:0:8}"
        seen_review="$seen_review $mainhead"
      fi
    fi
  fi

  # ---- lane D: new dependabot alerts (every DEP_EVERY passes) --------------
  if [ $((pass % DEP_EVERY)) -eq 0 ] && command -v gh >/dev/null 2>&1; then
    known="$(jq -r '(.knownDependabotAlerts // []) | join(" ")' "$STATE" 2>/dev/null)"
    alerts="$(gh api repos/crowi/crowi/dependabot/alerts --paginate -X GET -f state=open \
      --jq '.[] | "\(.number)\t\(.security_advisory.severity)\t\(.dependency.package.name)"' 2>/dev/null)"
    while IFS=$'\t' read -r num sev pkg; do
      [ -n "$num" ] || continue
      has "$num" "$known" && continue
      has "$num" "$seen_dep" || { echo "NEW_DEPENDABOT: #$num $sev $pkg"; seen_dep="$seen_dep $num"; }
    done <<EOF
$alerts
EOF
  fi

  [ "$ONCE" = 1 ] && exit 0
  pass=$((pass + 1))
  sleep "$INTERVAL"
done
