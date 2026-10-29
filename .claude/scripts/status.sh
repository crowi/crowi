#!/usr/bin/env bash
# status.sh — one read-only snapshot of where work stands, as markdown tables:
# main (unpushed commits), each worktree (ahead/behind, task status, whether
# its branch is already in main), every spec's status, and the latest release
# with its team wiki record. Run it before answering "did we already do X?"
# instead of reconstructing the answer from memory.
#
# Usage: status.sh [--no-remote]
#          --no-remote: skip the gh / wiki lookups (offline, faster)
set -u

# The main worktree is the first entry of `git worktree list`, whichever
# checkout this copy of the script runs from.
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" worktree list --porcelain | sed -n '1s/^worktree //p')"
TASKS="$ROOT/.feature-state/tasks"
SPECS="$ROOT/.feature-state/specs"
REMOTE=1
[ "${1:-}" = "--no-remote" ] && REMOTE=0

cd "$ROOT" || exit 1

# frontmatter_field <file> <key> — value of a top-level key in the leading
# `---` block, empty when absent.
frontmatter_field() {
  awk -v k="$2" 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
    NR > 1 { i = index($0, ":"); if (i && substr($0, 1, i - 1) == k) { v = substr($0, i + 1); sub(/^ +/, "", v); print v; exit } }' "$1"
}

echo "## main"
echo
head="$(git rev-parse --short main)"
unpushed="$(git rev-list --count origin/main..main 2>/dev/null || echo '?')"
dirty="clean"
[ -n "$(git status --porcelain 2>/dev/null)" ] && dirty="dirty"
echo "| head | unpushed | working tree |"
echo "|---|---|---|"
echo "| $head | $unpushed | $dirty |"
if [ "$unpushed" != "0" ] && [ "$unpushed" != "?" ]; then
  echo
  git log --oneline origin/main..main | sed 's/^/- /'
fi

echo
echo "## worktrees"
echo
echo "| id | branch | ahead | behind | task | in main | last commit |"
echo "|---|---|---|---|---|---|---|"
git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
  [ "$wt" = "$ROOT" ] && continue
  id="$(basename "$wt")"; id="${id#crowi-}"
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  ahead="$(git -C "$wt" rev-list --count main..HEAD 2>/dev/null || echo '?')"
  behind="$(git -C "$wt" rev-list --count HEAD..main 2>/dev/null || echo '?')"
  task="-"
  [ -f "$TASKS/$id.json" ] && task="$(jq -r '.status // "-"' "$TASKS/$id.json" 2>/dev/null)"
  merged="no"
  git merge-base --is-ancestor "$(git -C "$wt" rev-parse HEAD)" main 2>/dev/null && merged="yes"
  last="$(git -C "$wt" log -1 --format=%cr 2>/dev/null)"
  echo "| $id | $branch | $ahead | $behind | $task | $merged | $last |"
done

echo
echo "## specs"
echo
echo "| id | status | ready | task |"
echo "|---|---|---|---|"
for f in "$SPECS"/*.md; do
  [ -f "$f" ] || continue
  id="$(basename "$f" .md)"
  # Some specs append a note to the status; the table keeps the first word.
  status="$(frontmatter_field "$f" status | sed 's/[ （(].*//')"
  ready="$(frontmatter_field "$f" implementation_ready)"
  task="-"
  [ -f "$TASKS/$id.json" ] && task="$(jq -r '.status // "-"' "$TASKS/$id.json" 2>/dev/null)"
  echo "| $id | ${status:--} | ${ready:--} | $task |"
done

echo
echo "## release"
echo
tag="$(git describe --tags --abbrev=0 --match 'v*' main 2>/dev/null)"
if [ -z "$tag" ]; then
  echo "no v* tag"
  exit 0
fi
date="$(git log -1 --format=%cd --date=format-local:%Y-%m-%d "$tag")"
since="$(git rev-list --count "$tag..main")"
pr="-" wiki="-"
if [ "$REMOTE" = 1 ]; then
  pr="$(gh pr list --head changeset-release/main --state open --json number --jq '.[0].number // "none"' 2>/dev/null || echo '?')"
  n="${tag##*.}"
  page="/crowi/release/${date//-//}/alpha-$n"
  # Only "Page not found" means the record is absent; any other failure
  # (network, expired login) is reported as unknown, never as missing.
  if err="$(crowi -p crowi-team-wiki get "$page" 2>&1 >/dev/null)"; then
    if index="$(crowi -p crowi-team-wiki get /crowi/release/ 2>/dev/null)"; then
      if printf '%s\n' "$index" | grep -q "^| \[$tag\]("; then
        wiki="page + index"
      else
        wiki="page only (index row missing)"
      fi
    else
      wiki="page + index unknown (lookup failed)"
    fi
  elif printf '%s' "$err" | grep -qi 'not found'; then
    wiki="missing ($page)"
  else
    wiki="unknown (lookup failed)"
  fi
fi
echo "| latest tag | date | commits since | open Version PR | wiki record |"
echo "|---|---|---|---|---|"
echo "| $tag | $date | $since | $pr | $wiki |"
