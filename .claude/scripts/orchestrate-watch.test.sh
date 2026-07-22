#!/usr/bin/env bash
# orchestrate-watch.test.sh — smoke tests for orchestrate-watch.sh's lane E
# "longLived" stall-threshold branch (feature-worktree-extra-gates).
#
# Not wired into any CI/lint pipeline: .claude/ is agent tooling, not product
# code (same convention as task-state.test.sh). Run it manually after
# touching orchestrate-watch.sh's lane E:
#   bash .claude/scripts/orchestrate-watch.test.sh
#
# Builds a throwaway git repo (a "main" plus several worktrees, each with one
# backdated commit) under a temp dir and points orchestrate-watch.sh at it via
# ORCH_ROOT (a test-only override — see the script's header) — never touches
# the real repo's worktrees or .feature-state/.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/orchestrate-watch.sh"

REQUIRED_TOOLS="git jq date sed grep basename dirname sleep"

for c in $REQUIRED_TOOLS bash; do
  command -v "$c" >/dev/null 2>&1 || { echo "SKIP: required tool not found: $c"; exit 0; }
done
BASH_BIN="$(command -v bash)"

# A minimal PATH that resolves $REQUIRED_TOOLS but deliberately excludes `gh`
# even if it is on the real PATH: lanes D (dependabot) and F (flaky-test
# issues) both fire unconditionally on pass 0 (0 % N == 0 for any N) whenever
# `gh` is reachable, which would make this lane-E-only test hit the real
# GitHub API. `bash` itself is invoked via its resolved full path (BASH_BIN,
# captured above) so it does not need to be reachable through this
# restricted PATH.
SAFE_PATH=""
for c in $REQUIRED_TOOLS; do
  d="$(dirname "$(command -v "$c")")"
  case ":$SAFE_PATH:" in *":$d:"*) ;; *) SAFE_PATH="$SAFE_PATH:$d" ;; esac
done
SAFE_PATH="${SAFE_PATH#:}"

WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)" # resolve symlinks (macOS /var -> /private/var)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
section() { echo; echo "== $1 =="; }

ROOT="$WORK/main"
mkdir -p "$ROOT/.feature-state/tasks"
git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email "test@example.invalid"
git -C "$ROOT" config user.name "orchestrate-watch test"
echo init >"$ROOT/seed.txt"
git -C "$ROOT" add seed.txt
git -C "$ROOT" commit -q -m "init"

# backdated_ts <days-ago> — ISO8601 UTC timestamp N days before now, portable
# across BSD date (macOS) and GNU date (Linux).
backdated_ts() {
  date -u -v-"$1"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ
}

# make_worktree <id> <days-ago>
# Adds a worktree at $WORK/<id> branched off main, with one commit backdated
# <days-ago> days — simulates a worktree whose last commit is that old.
make_worktree() {
  local id="$1" days="$2" wt="$WORK/$1" ts
  git -C "$ROOT" worktree add -q -b "$id/impl" "$wt" main >/dev/null 2>&1
  echo "wip" >"$wt/wip.txt"
  git -C "$wt" add wip.txt
  ts="$(backdated_ts "$days")"
  GIT_AUTHOR_DATE="$ts" GIT_COMMITTER_DATE="$ts" \
    git -C "$wt" -c user.email="test@example.invalid" -c user.name="orchestrate-watch test" \
    commit -q -m "wip on $id"
}

# task_json <id> <true|false>
# Writes a fixture task.json with the given longLived value. Only
# `longLived` (and `readyForMerge.headSha`, absent here) are read by lane E
# — no other fields are included since orchestrate-watch.sh never looks at
# them.
task_json() {
  local id="$1" long="$2"
  printf '{"longLived": %s}\n' "$long" >"$ROOT/.feature-state/tasks/$id.json"
}

# ---------------------------------------------------------------------------
section "fixtures"
make_worktree "legacy-stale" 5 # no task file at all (backward-compat baseline)
task_json "longlived-not-yet" true
make_worktree "longlived-not-yet" 5 # 5d < ORCH_STALL_DAYS_LONG(14)
task_json "longlived-stalled" true
make_worktree "longlived-stalled" 20 # 20d >= ORCH_STALL_DAYS_LONG(14)
task_json "longlived-false-stale" false
make_worktree "longlived-false-stale" 5 # explicit false -> normal threshold(3)
ok "fixture worktrees + task files created"

# ---------------------------------------------------------------------------
section "lane E: single --once pass"
OUT="$(PATH="$SAFE_PATH" ORCH_ROOT="$ROOT" ORCH_STALL_DAYS=3 ORCH_STALL_DAYS_LONG=14 \
  "$BASH_BIN" "$SCRIPT" --once 2>&1)"
echo "$OUT" | sed 's/^/  /'

# assert_stalled <id> <yes|no> <ok-message> <fail-message>
# Asserts whether `<id>` was (yes) or was not (no) reported STALLED in $OUT.
assert_stalled() {
  local id="$1" expect="$2" ok_msg="$3" fail_msg="$4" found=no
  echo "$OUT" | grep -q "^STALLED: $id (" && found=yes
  [ "$found" = "$expect" ] && ok "$ok_msg" || fail "$fail_msg"
}

assert_stalled legacy-stale yes \
  "no task file (legacy) still uses ORCH_STALL_DAYS (5d >= 3d -> STALLED)" \
  "legacy-stale should have been reported STALLED"

assert_stalled longlived-not-yet no \
  "longLived task under the long threshold is not reported yet" \
  "longlived-not-yet should NOT be reported (5d < ORCH_STALL_DAYS_LONG 14d)"

assert_stalled longlived-stalled yes \
  "longLived task past ORCH_STALL_DAYS_LONG (20d >= 14d) is reported STALLED" \
  "longlived-stalled should have been reported STALLED"

assert_stalled longlived-false-stale yes \
  "longLived: false explicitly still uses the normal ORCH_STALL_DAYS threshold" \
  "longlived-false-stale should have been reported STALLED (normal threshold)"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
