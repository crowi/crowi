#!/usr/bin/env bash
# git-test-env-isolation.test.sh — the shell tests must not write into the
# repository whose hook is running them.
#
# A git hook exports `GIT_DIR`, and from a linked worktree that is an absolute
# path to the worktree's admin directory. Git reads it in preference to `-C`,
# so without `git-test-env.sh` a fixture's `git init` / `git config` /
# `git worktree add` all land in the real repository instead (see that file).
# This test recreates the hook environment against a throwaway repository and
# requires that nothing in it changes.
#
# Run directly, or through `pnpm test:scripts:sh`:
#   bash .claude/scripts/git-test-env-isolation.test.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.claude/scripts/git-test-env.sh
source "$HERE/git-test-env.sh"

for c in git bash mktemp; do
  command -v "$c" >/dev/null 2>&1 || { echo "SKIP: required tool not found: $c"; exit 0; }
done

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)" # macOS /var -> /private/var
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# The canary stands in for the real repository: a main worktree plus a linked
# one, so the hook environment can point at a linked admin directory.
CANARY="$WORK/canary"
mkdir -p "$CANARY"
git -C "$CANARY" init -q -b main
git -C "$CANARY" config user.email "canary@example.invalid"
git -C "$CANARY" config user.name "git-test-env canary"
echo seed >"$CANARY/seed.txt"
git -C "$CANARY" add seed.txt
git -C "$CANARY" commit -q -m "seed"
git -C "$CANARY" worktree add -q -b canary/impl "$WORK/canary-linked" main
LINKED_GIT_DIR="$(git -C "$WORK/canary-linked" rev-parse --absolute-git-dir)"

snapshot() {
  cat "$CANARY/.git/config"
  echo "--refs--"
  git -C "$CANARY" for-each-ref --format='%(refname) %(objectname)' refs/heads
  echo "--worktrees--"
  git -C "$CANARY" worktree list --porcelain
  echo "--linked-head--"
  cat "$LINKED_GIT_DIR/HEAD"
}

BEFORE="$WORK/before.txt"
AFTER="$WORK/after.txt"
snapshot >"$BEFORE"

# Every shell test the repo runs, under the environment a linked worktree's
# pre-push hook hands to lefthook. `GIT_WORK_TREE` stays unset, which is what
# makes a stray `git init` mark the shared config bare.
SUITE=(
  "$HERE/orchestrate-watch.test.sh"
  "$HERE/task-state.test.sh"
  "$HERE/../skills/crowi-feature/tests/pipeline-contract-v2-review.test.sh"
  "$HERE/../skills/_shared/tests/validate-implementation-spec.test.sh"
  "$HERE/../skills/_shared/tests/e2e-gate.test.sh"
)

for t in "${SUITE[@]}"; do
  name="$(basename "$t")"
  if [ ! -f "$t" ]; then
    fail "$name is listed here but missing on disk"
    continue
  fi
  if GIT_DIR="$LINKED_GIT_DIR" bash "$t" >"$WORK/$name.log" 2>&1; then
    ok "$name passes with a hook's GIT_DIR in the environment"
  else
    fail "$name exited non-zero under a hook's GIT_DIR (see $WORK/$name.log)"
  fi
done

snapshot >"$AFTER"

if diff -u "$BEFORE" "$AFTER" >"$WORK/canary.diff"; then
  ok "the canary repository is untouched"
else
  fail "the canary repository changed:"
  sed -n '1,40p' "$WORK/canary.diff"
fi

bare="$(git -C "$CANARY" config --local --get core.bare || true)"
case "$bare" in
  "" | false) ok "the canary config is not marked bare" ;;
  *) fail "the canary config was marked bare (core.bare=$bare)" ;;
esac

if git -C "$CANARY" config --local --list | grep -q "example.invalid" && \
   ! git -C "$CANARY" config --local --get user.email | grep -q "^canary@"; then
  fail "a fixture identity replaced the canary's own"
else
  ok "the canary keeps its own identity"
fi

echo
echo "git-test-env-isolation: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
