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
#   NEW_FLAKY_ISSUE: #<num> <title>                   (lane F — act: report only; fix is /crowi-fix)
#   UPDATED_FLAKY_ISSUE: #<num> <title>               (lane F — act: report only; fix is /crowi-fix)
#
# Read-only by design: state files (.feature-state/orchestrate-state.json) are
# only READ here; the model updates them when it acts on an event (keeps the
# existing lane contracts unchanged). Dedup is in-memory per watcher lifetime —
# a restarted watcher may re-emit current facts once, which is safe (the model
# re-verifies before acting).
#
# Usage: orchestrate-watch.sh [--once]     (--once: single pass for testing)
# Env:   ORCH_ROOT (override the repo root; test-only, see
#        orchestrate-watch.test.sh — unset in normal agent use),
#        ORCH_WATCH_INTERVAL (default 60s), ORCH_STALL_DAYS (default 3),
#        ORCH_STALL_DAYS_LONG (default 14 — used instead of ORCH_STALL_DAYS
#        for worktrees whose task.json has "longLived": true, e.g. multi-phase
#        umbrella features that legitimately span longer than the normal
#        stall threshold),
#        ORCH_DEP_EVERY (dependabot check every Nth pass, default 30),
#        ORCH_FLAKE_EVERY (flaky-test issue check every Nth pass, default 30)
set -u

# Resolves to the real repo root (two dirs up from this script) unless
# ORCH_ROOT overrides it — see the "Env:" block above for what sets it.
ROOT="${ORCH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TASKS="$ROOT/.feature-state/tasks"
STATE="$ROOT/.feature-state/orchestrate-state.json"
INTERVAL="${ORCH_WATCH_INTERVAL:-60}"
STALL_DAYS="${ORCH_STALL_DAYS:-3}"
STALL_DAYS_LONG="${ORCH_STALL_DAYS_LONG:-14}"
DEP_EVERY="${ORCH_DEP_EVERY:-30}"
FLAKE_EVERY="${ORCH_FLAKE_EVERY:-30}"
ONCE=0; [ "${1:-}" = "--once" ] && ONCE=1

seen_ready="" seen_stall="" seen_review="" seen_dep="" seen_flake=""
flake_baseline_seeded=0
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
    # longLived task.json marker → use the extended threshold (default 14d)
    # instead of the normal one (default 3d). Absent/false/missing task file
    # all fall through to the normal threshold — fully backward compatible.
    long="$(jq -r '.longLived // false' "$TASKS/$id.json" 2>/dev/null)"
    threshold="$STALL_DAYS"
    [ "$long" = "true" ] && threshold="$STALL_DAYS_LONG"
    last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
    age_d=$(( ($(date +%s) - last) / 86400 ))
    [ "$age_d" -ge "$threshold" ] || continue
    key="$id:$head"
    has "$key" "$seen_stall" || { echo "STALLED: $id ($n ahead, last commit ${age_d}d ago, no fresh signal)"; seen_stall="$seen_stall $key"; }
  done <<EOF
$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF

  # ---- lane C: main direct-work review threshold ---------------------------
  # Dedup on BASE (lastReviewedMainSha), not main head: main advances with every
  # commit and would re-emit each time; base only moves when the model acts on
  # the review (updates lastReviewedMainSha), which is exactly when a fresh
  # threshold event becomes meaningful again.
  base="$(jq -r '.lastReviewedMainSha // empty' "$STATE" 2>/dev/null)"
  if [ -n "$base" ] && git -C "$ROOT" rev-parse -q --verify "$base" >/dev/null 2>&1; then
    mainhead="$(git -C "$ROOT" rev-parse main 2>/dev/null)"
    if [ "$mainhead" != "$base" ] && ! has "$base" "$seen_review"; then
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
        seen_review="$seen_review $base"
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

  # ---- lane F: new/updated flaky-test issues (every FLAKE_EVERY passes) ----
  # `flaky-test`-labeled issues are filed/updated by
  # scripts/test-flake-report-issue.mjs (CI `flake-report` job) — this lane
  # only detects and reports (new issue, or an existing one's updatedAt moved
  # forward = a fresh occurrence comment). It never files/fixes/closes
  # anything; the fixer is a human/manager decision (`/crowi-fix`).
  if [ $((pass % FLAKE_EVERY)) -eq 0 ] && command -v gh >/dev/null 2>&1; then
    if flaky_issues="$(gh issue list --repo crowi/crowi --label flaky-test --state open --json number,title,updatedAt --limit 200 \
      --jq '.[] | "\(.number)\t\(.updatedAt)\t\(.title)"' 2>/dev/null)"; then
      # Seeding pass: no on-disk baseline yet (`knownFlakyTestIssues` key
      # absent — state is only ever written by the model, after it acts on a
      # report, never by this read-only script). Absorb the CURRENT open set
      # into the in-memory dedup set silently instead of reporting every
      # pre-existing flaky-test issue as NEW (AC-7/AC-8). Once per watcher
      # lifetime (`flake_baseline_seeded`) — later passes compare normally
      # even while the on-disk key is still unset (it becomes accurate as soon
      # as the model acts on any reported event and writes the known set).
      seeding=0
      if [ "$flake_baseline_seeded" -eq 0 ] && ! jq -e 'has("knownFlakyTestIssues")' "$STATE" >/dev/null 2>&1; then
        seeding=1
      fi
      # Two jq-built sets for the `has` idiom the other lanes use: a number set
      # (is this issue known at all → NEW) and a number:updatedAt set (known at
      # THIS updatedAt → nothing; known at an older one → UPDATED).
      known_nums="$(jq -r '(.knownFlakyTestIssues // []) | map(.number) | join(" ")' "$STATE" 2>/dev/null)"
      known_keys="$(jq -r '(.knownFlakyTestIssues // []) | map("\(.number):\(.updatedAt)") | join(" ")' "$STATE" 2>/dev/null)"
      while IFS=$'\t' read -r num updated title; do
        [ -n "$num" ] || continue
        key="$num:$updated"
        has "$key" "$seen_flake" && continue
        seen_flake="$seen_flake $key"
        [ "$seeding" -eq 1 ] && continue
        if ! has "$num" "$known_nums"; then
          echo "NEW_FLAKY_ISSUE: #$num $title"
        elif ! has "$key" "$known_keys"; then
          echo "UPDATED_FLAKY_ISSUE: #$num $title"
        fi
      done <<EOF
$flaky_issues
EOF
      [ "$seeding" -eq 1 ] && flake_baseline_seeded=1
    fi
    # else: `gh issue list` itself failed this pass (rate limit/network/auth
    # blip) — skip lane F ENTIRELY for this pass, do not touch
    # flake_baseline_seeded/seen_flake. A failure must never be silently
    # coerced into "zero open issues": doing so before the baseline is seeded
    # would mark it seeded with an empty set, so a LATER successful pass would
    # see every pre-existing open issue as unseen and misreport it as
    # NEW_FLAKY_ISSUE (the exact recovery-path false positive this guard
    # exists to prevent).
  fi

  [ "$ONCE" = 1 ] && exit 0
  pass=$((pass + 1))
  sleep "$INTERVAL"
done
