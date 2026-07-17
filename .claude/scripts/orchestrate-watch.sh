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
# Env:   ORCH_WATCH_INTERVAL (default 60s), ORCH_STALL_DAYS (default 3),
#        ORCH_DEP_EVERY (dependabot check every Nth pass, default 30),
#        ORCH_FLAKE_EVERY (flaky-test issue check every Nth pass, default 30)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASKS="$ROOT/.feature-state/tasks"
STATE="$ROOT/.feature-state/orchestrate-state.json"
INTERVAL="${ORCH_WATCH_INTERVAL:-60}"
STALL_DAYS="${ORCH_STALL_DAYS:-3}"
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
    last=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
    age_d=$(( ($(date +%s) - last) / 86400 ))
    [ "$age_d" -ge "$STALL_DAYS" ] || continue
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
    flaky_issues="$(gh issue list --repo crowi/crowi --label flaky-test --state open --json number,title,updatedAt --limit 200 \
      --jq '.[] | "\(.number)\t\(.updatedAt)\t\(.title)"' 2>/dev/null)"
    gh_flake_status=$?
    if [ "$gh_flake_status" -eq 0 ]; then
      has_flake_baseline=1
      jq -e 'has("knownFlakyTestIssues")' "$STATE" >/dev/null 2>&1 || has_flake_baseline=0
      known_lines="$(jq -r '(.knownFlakyTestIssues // [])[] | "\(.number) \(.updatedAt)"' "$STATE" 2>/dev/null)"
      if [ "$has_flake_baseline" -eq 0 ] && [ "$flake_baseline_seeded" -eq 0 ]; then
        # No on-disk baseline yet (`knownFlakyTestIssues` key absent — state is
        # only ever written by the model, after it acts on a report, never by
        # this read-only script). Silently absorb the CURRENT open set into the
        # in-memory dedup set instead of reporting every pre-existing
        # flaky-test issue as NEW (AC-7/AC-8: same first-run "既存はサイレント受理"
        # treatment as lane D's documented, but here actually enforced,
        # contract). Guarded by flake_baseline_seeded so this absorption only
        # happens once per watcher lifetime — once seeded, later passes fall
        # through to the normal comparison below even though the on-disk key
        # may still be unset (it becomes accurate again as soon as the model
        # acts on any reported event and writes the current known set).
        while IFS=$'\t' read -r num updated _title; do
          [ -n "$num" ] || continue
          seen_flake="$seen_flake $num:$updated"
        done <<EOF
$flaky_issues
EOF
        flake_baseline_seeded=1
      else
        while IFS=$'\t' read -r num updated title; do
          [ -n "$num" ] || continue
          key="$num:$updated"
          has "$key" "$seen_flake" && continue
          seen_flake="$seen_flake $key"
          known_updated="$(printf '%s\n' "$known_lines" | awk -v n="$num" '$1==n{print $2; exit}')"
          if [ -z "$known_updated" ]; then
            echo "NEW_FLAKY_ISSUE: #$num $title"
          elif [ "$known_updated" != "$updated" ]; then
            echo "UPDATED_FLAKY_ISSUE: #$num $title"
          fi
        done <<EOF
$flaky_issues
EOF
      fi
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
