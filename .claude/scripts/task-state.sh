#!/usr/bin/env bash
# task-state.sh — the ONLY allowed way to mutate crowi-feature pipeline state
# (.feature-state/tasks/<id>.json and .feature-state/queue.json). A PreToolUse
# hook (.claude/scripts/validate-task-state-write.js) blocks Write/Edit on
# those paths so agents cannot fall back to the old "read whole JSON ->
# regenerate -> write back" pattern, which caused two real corruption
# incidents (0-byte truncation, and a silent structural rewrite that flipped
# phases[].autoContinue from false to true — defeating a human gate). See
# .feature-state/specs/feature-task-state-script.md for the incident writeup
# and design rationale.
#
# Every write goes through: jq transform -> reparse-validate (tmp) ->
# structural invariant checks -> backup current version to <file>.bak ->
# atomic rename. A short noclobber lock (<file>.lock) serializes concurrent
# writers; a busy lock fails fast (non-zero, holder printed) rather than
# blocking.
#
# Usage:
#   task-state.sh task create <id> <draft-json-path>
#   task-state.sh task get <id>
#   task-state.sh task set-status <id> <STATUS>
#   task-state.sh task set-phase-status <id> <phase-id> <STATUS>
#   task-state.sh task append-history <id> <text-or-json> [--value-file <path>]
#   task-state.sh task set-field <id> <field> [<value>] [--phase <phase-id>] [--value-file <path>]
#   task-state.sh task replace-unsafe <id> <new-json-path> --reason "<why>"
#   task-state.sh queue set-current <id|null>
#   task-state.sh queue get
#   task-state.sh --help
#
# See --help for the full field allowlist, protected fields, invariants, and
# the recovery procedure. Run the smoke tests with:
#   bash .claude/scripts/task-state.test.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# TASK_STATE_STATE_DIR overrides the state dir root for the smoke test suite
# (task-state.test.sh) so tests never touch the real .feature-state/. Unset
# in normal (agent) use — defaults to the real repo-root state dir.
STATE_DIR="${TASK_STATE_STATE_DIR:-$ROOT/.feature-state}"
TASKS_DIR="$STATE_DIR/tasks"
QUEUE_FILE="$STATE_DIR/queue.json"

# ---- schema (grep-derived from the real .feature-state/tasks/*.json corpus
# and the feature-{planner,implementer,reviewer,committer} agent docs as of
# 2026-07-15 — see the task's openQuestions resolution in its history) -------
STATUS_ENUM=(PLANNED IN_PROGRESS REVIEW NEEDS_WORK APPROVED COMMITTED PARTIALLY_COMMITTED READY_TO_INTEGRATE INTEGRATED)
# Required on every task file after every write (invariant 2). "openQuestions"
# and "phases" are required going forward even though a few pre-existing
# synthesized/fix-* tasks predate this script and lack them — task-state.sh
# only ever touches files it creates/mutates itself, so this is forward-only.
# "phases" must always be present (an array — [] for a task with no per-phase
# breakdown; task-state.sh does not care whether a single-phase task is
# represented as [] or as a one-element [{id:'main',...}], see
# feature-planner.md / crowi-feature/SKILL.md for the convention agents use)
# — this is what stops a re-plan from silently dropping the whole phase
# structure (the second real incident this script exists to prevent).
REQUIRED_TOP_KEYS=(id name status scope context openQuestions history phases)
# Settable via `task set-field` (top-level, or --phase-scoped on a phases[]
# entry). Deliberately excludes: id (invariant 5), status/phases[].status
# (use set-status/set-phase-status so the enum is validated), history (append
# only), phases (structural — only replace-unsafe may resize/reshape it), and
# phases[].title / specSectionAnchor / autoContinue (invariant 4 — protected,
# only replace-unsafe may change them).
MUTABLE_FIELDS=(
  name description priority scope stack dependencies context
  acceptanceCriteria openQuestions outOfScope commitPlan commitInfo
  reviewFeedback reviewAttempts readyForMerge currentPhase commitShas origin
  integratedAt integratedMergeCommit integratedVia implementationNotes
  decisions blockedOn
)

die() {
  echo "task-state.sh: error: $*" >&2
  exit 1
}

usage_err() {
  echo "task-state.sh: usage: $*" >&2
  exit 2
}

utc_now() { date -u +%FT%TZ; }

require_jq() {
  command -v jq >/dev/null 2>&1 || die "jq is required but not found on PATH"
}

is_valid_status() {
  local s="$1" e
  for e in "${STATUS_ENUM[@]}"; do [ "$s" = "$e" ] && return 0; done
  return 1
}

is_mutable_field() {
  local f="$1" e
  for e in "${MUTABLE_FIELDS[@]}"; do [ "$f" = "$e" ] && return 0; done
  return 1
}

# is_valid_json_content <content>
# True if <content> (a JSON document held in a shell variable, as opposed to
# a path on disk) parses as JSON.
is_valid_json_content() {
  printf '%s' "$1" | jq -e . >/dev/null 2>&1
}

# require_valid_id <id>
# Every subcommand that turns a caller-supplied <id> into a path
# ($TASKS_DIR/$id.json) MUST call this first. Task ids are restricted to a
# safe lowercase kebab-case basename (matching the real .feature-state/tasks/
# corpus, e.g. "feature-foo-bar", "fix-mcp-endpoint") — this is what stops an
# id like "../../etc/passwd" or "../queue" from escaping $TASKS_DIR to read or
# overwrite an arbitrary path on disk. No '/', no '.', no leading digit/hyphen.
require_valid_id() {
  local id="$1"
  [[ "$id" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] \
    || die "invalid task id: '$id' (must be lowercase kebab-case, e.g. 'feature-foo-bar' — no '/', '.', or leading digit/hyphen; this restriction exists because the id is used to build a file path under $TASKS_DIR)"
}

# find_missing_required_key <json-content>
# Echoes the first missing required top-level key and returns 0 (found), or
# returns 1 (none missing) with no output.
find_missing_required_key() {
  local content="$1" k
  for k in "${REQUIRED_TOP_KEYS[@]}"; do
    if [ "$(printf '%s' "$content" | jq --arg k "$k" 'has($k)' 2>/dev/null)" != "true" ]; then
      printf '%s' "$k"
      return 0
    fi
  done
  return 1
}

# validate_phases_shape <json-content>
# Shared phases[] structural contract for the two subcommands that write a
# whole caller-supplied document rather than mutating in place (`task
# create`'s draft and `task replace-unsafe`'s replacement — the latter is
# exempt from invariants 3/4 via --relax-phases, but NOT from this: a
# replacement must still have a well-formed phases[], just one that is
# allowed to differ in count/protected fields from the file it replaces).
# Dies with a descriptive message on any violation.
validate_phases_shape() {
  local content="$1"
  [ "$(printf '%s' "$content" | jq -r '.phases | type' 2>/dev/null)" = "array" ] \
    || die "'phases' must be an array (use [] for a task with no per-phase breakdown)"
  local pcount i
  pcount="$(printf '%s' "$content" | jq '.phases | length')"
  for ((i = 0; i < pcount; i++)); do
    local pf
    for pf in id title specSectionAnchor autoContinue status; do
      [ "$(printf '%s' "$content" | jq --argjson i "$i" --arg k "$pf" '.phases[$i] | has($k)')" = "true" ] \
        || die "phases[$i] missing field: $pf"
    done
    local pstatus
    pstatus="$(printf '%s' "$content" | jq -r --argjson i "$i" '.phases[$i].status')"
    is_valid_status "$pstatus" || die "phases[$i] has invalid status: $pstatus"
  done
  if [ "$pcount" -gt 0 ]; then
    local dupe
    dupe="$(printf '%s' "$content" | jq '([.phases[].id] | length) != ([.phases[].id] | unique | length)')"
    [ "$dupe" = "false" ] || die "duplicate phase ids in phases[]"
  fi
}

# to_json_value <raw> <value-file>
# Resolves a CLI value into a JSON text: --value-file wins if non-empty (must
# itself be valid JSON); otherwise <raw> is used as-is if it already parses as
# JSON, else it is wrapped as a JSON string. Always echoes valid JSON text.
to_json_value() {
  local raw="$1" value_file="$2"
  if [ -n "$value_file" ]; then
    [ -s "$value_file" ] || die "value file missing or empty: $value_file"
    jq -e . "$value_file" >/dev/null 2>&1 || die "value file is not valid JSON: $value_file"
    cat "$value_file"
    return 0
  fi
  if is_valid_json_content "$raw"; then
    printf '%s' "$raw"
  else
    jq -Rn --arg v "$raw" '$v'
  fi
}

# ---- locking (noclobber, non-blocking — same shape as CLAUDE.md's
# main-write.lock convention) -------------------------------------------------
LOCKS_HELD=()
acquire_lock() {
  local lockfile="$1"
  if ( set -o noclobber; printf '{"pid":%s,"at":"%s"}\n' "$$" "$(utc_now)" > "$lockfile" ) 2>/dev/null; then
    LOCKS_HELD+=("$lockfile")
    return 0
  fi
  echo "task-state.sh: error: lock busy: $lockfile" >&2
  echo "  holder: $(cat "$lockfile" 2>/dev/null || echo '(unreadable)')" >&2
  exit 1
}
release_locks() {
  local l
  for l in "${LOCKS_HELD[@]:-}"; do
    [ -n "$l" ] && rm -f "$l"
  done
}
trap release_locks EXIT

# write_atomic <file> <content>
# tmp -> reparse-validate -> backup current version to <file>.bak -> rename.
# On ANY failure (tmp write, tmp validation, backup, or rename itself) the
# .tmp file is discarded (never left behind for a later invocation to trip
# over) and <file> (plus any pre-existing .bak) is left completely untouched
# — this is the one behavior every failure branch below must uphold.
write_atomic() {
  local file="$1" content="$2"
  local tmp="$file.tmp"
  if ! printf '%s\n' "$content" > "$tmp"; then
    rm -f "$tmp"
    die "internal error: failed to write tmp file $tmp (original left untouched, tmp discarded)"
  fi
  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    die "internal error: refusing to write invalid JSON to $file (original left untouched, tmp discarded)"
  fi
  if [ -f "$file" ]; then
    if ! cp -p "$file" "$file.bak"; then
      rm -f "$tmp"
      die "refusing write: failed to back up $file to $file.bak (original left untouched, no new .bak was created, tmp discarded — a write is never allowed to proceed without a fresh backup)"
    fi
  fi
  if ! mv "$tmp" "$file"; then
    rm -f "$tmp"
    die "internal error: backup succeeded but renaming $tmp over $file failed (e.g. permissions/disk) — $file.bak holds the pre-write version (identical to the untouched original in this failure case, since the backup always runs before the rename attempt); $file itself was not modified by this failed mv; tmp discarded. Verify with 'jq . \"$file\"' before retrying."
  fi
}

# read_current_task_content <id> -> echoes content, dies (untouched) if the
# task doesn't exist or is already corrupt.
read_current_task_content() {
  local id="$1"
  require_valid_id "$id"
  local file="$TASKS_DIR/$id.json" content
  [ -f "$file" ] || die "task not found: $id (use 'task create' first)"
  content="$(cat "$file")"
  if ! is_valid_json_content "$content"; then
    die "current task file is corrupt (invalid JSON): $file — restore it from $file.bak first (cp \"$file.bak\" \"$file\"), verify with 'jq . \"$file\"', then retry. Refusing to write on top of corrupt state."
  fi
  printf '%s' "$content"
}

# require_phase_exists <content> <phase-id> <id>
# Dies with a consistent message unless <phase-id> is present in <content>'s
# phases[]. Shared by set-phase-status and set-field --phase.
require_phase_exists() {
  local content="$1" phase_id="$2" id="$3"
  local has_phase
  has_phase="$(printf '%s' "$content" | jq --arg p "$phase_id" '(.phases // []) | any(.id == $p)')"
  [ "$has_phase" = "true" ] || die "phase not found: $phase_id (task $id)"
}

# commit_task_change <id> <old-content> <new-content> [--relax-phases]
# Runs invariants 1/2/5 always, and 3/4 unless --relax-phases (replace-unsafe
# only), then writes atomically.
commit_task_change() {
  local id="$1" old_content="$2" new_content="$3" relax="${4:-}"
  local file="$TASKS_DIR/$id.json"

  # invariant 1: new content must parse
  if ! is_valid_json_content "$new_content"; then
    die "refusing write: transformed content is not valid JSON (invariant 1)"
  fi

  # invariant 2: required top-level keys still present
  local miss
  if miss="$(find_missing_required_key "$new_content")"; then
    die "refusing write: required top-level key missing after transform: $miss (invariant 2)"
  fi

  # invariant 5: id never changes
  local old_id new_id
  old_id="$(printf '%s' "$old_content" | jq -r '.id')"
  new_id="$(printf '%s' "$new_content" | jq -r '.id')"
  [ "$old_id" = "$new_id" ] || die "refusing write: id changed ($old_id -> $new_id) (invariant 5)"

  if [ "$relax" != "--relax-phases" ]; then
    # invariant 3: phases[] element count unchanged
    local old_pc new_pc
    old_pc="$(printf '%s' "$old_content" | jq '(.phases // []) | length')"
    new_pc="$(printf '%s' "$new_content" | jq '(.phases // []) | length')"
    if [ "$old_pc" != "$new_pc" ]; then
      die "refusing write: phases[] count changed ($old_pc -> $new_pc); use 'task replace-unsafe' for re-planning (invariant 3)"
    fi

    # invariant 4: phases[].{title,specSectionAnchor,autoContinue} unchanged
    # (matched by id, not array position, in case ordering ever differs)
    if [ "$old_pc" != "0" ]; then
      local diff_out
      diff_out="$(diff \
        <(printf '%s' "$old_content" | jq -S '[.phases[] | {id, title, specSectionAnchor, autoContinue}] | sort_by(.id)') \
        <(printf '%s' "$new_content" | jq -S '[.phases[] | {id, title, specSectionAnchor, autoContinue}] | sort_by(.id)'))"
      if [ -n "$diff_out" ]; then
        die "refusing write: protected phase fields (title/specSectionAnchor/autoContinue) changed; use 'task replace-unsafe' for re-planning (invariant 4)
$diff_out"
      fi
    fi
  fi

  write_atomic "$file" "$new_content"
}

# ============================================================================
# task subcommands
# ============================================================================

task_create() {
  local id="${1:-}" draft="${2:-}"
  [ -n "$id" ] && [ -n "$draft" ] || usage_err "task create <id> <draft-json-path>"
  require_valid_id "$id"
  local file="$TASKS_DIR/$id.json"
  # Fast-fail convenience check (NOT the authoritative one — see the recheck
  # after acquire_lock below, which is what actually prevents the TOCTOU race
  # of two concurrent `task create` calls for the same id).
  [ -e "$file" ] && die "task already exists: $id (use the set-* subcommands, or 'task replace-unsafe' for re-plan — 'create' is for brand-new tasks only)"
  [ -s "$draft" ] || die "draft file missing or empty: $draft"
  jq -e . "$draft" >/dev/null 2>&1 || die "draft is not valid JSON: $draft"

  local draft_id
  draft_id="$(jq -r '.id // empty' "$draft")"
  [ "$draft_id" = "$id" ] || die "draft .id ('$draft_id') does not match the requested id ('$id')"

  local miss
  if miss="$(find_missing_required_key "$(cat "$draft")")"; then
    die "draft missing required top-level key: $miss"
  fi

  local status
  status="$(jq -r '.status' "$draft")"
  is_valid_status "$status" || die "draft has invalid status: $status (allowed: ${STATUS_ENUM[*]})"

  # "phases" is a required top-level key (invariant 2, enforced above by
  # find_missing_required_key) and must be an array: [] for a task with no
  # per-phase breakdown, or a populated array for a multi-phase task — see
  # feature-planner.md / crowi-feature/SKILL.md for the convention agents use
  # when they do choose to enumerate one). validate_phases_shape dies (exits)
  # with a descriptive message on any violation; it is shared with
  # replace-unsafe below so the two subcommands cannot drift apart.
  validate_phases_shape "$(cat "$draft")"

  # Test-only race-injection seam (unset in normal agent use — a no-op then):
  # widens the window between the fast-fail check above and the lock
  # acquisition below, so task-state.test.sh can deterministically reproduce
  # the create-time TOCTOU race (two concurrent `task create` calls for the
  # same id) and assert the recheck-after-lock fix below actually fires.
  if [ -n "${TASK_STATE_TEST_RACE_DELAY:-}" ]; then
    sleep "$TASK_STATE_TEST_RACE_DELAY"
  fi

  mkdir -p "$TASKS_DIR"
  acquire_lock "$file.lock"
  # Authoritative existence check: another process may have created $file
  # between the fast-fail check above and this lock acquisition. Without this
  # recheck, the loser of that race would silently overwrite the winner's
  # file and still report success once it acquires the (by-then-free) lock.
  if [ -e "$file" ]; then
    die "task already exists: $id (created concurrently by another process while this one was validating its draft — run 'task get $id' to see which draft won)"
  fi
  write_atomic "$file" "$(cat "$draft")"
  echo "task-state.sh: task $id created from $draft"
}

task_get() {
  local id="${1:-}"
  [ -n "$id" ] || usage_err "task get <id>"
  require_valid_id "$id"
  local file="$TASKS_DIR/$id.json"
  [ -f "$file" ] || die "task not found: $id"
  jq -e . "$file" >/dev/null 2>&1 || die "task file is corrupt (invalid JSON): $file — restore from $file.bak"
  jq . "$file"
}

task_set_status() {
  local id="${1:-}" status="${2:-}"
  [ -n "$id" ] && [ -n "$status" ] || usage_err "task set-status <id> <STATUS>"
  require_valid_id "$id"
  is_valid_status "$status" || die "invalid status: $status (allowed: ${STATUS_ENUM[*]})"
  local file="$TASKS_DIR/$id.json"
  acquire_lock "$file.lock"
  local old_content new_content
  old_content="$(read_current_task_content "$id")"
  new_content="$(printf '%s' "$old_content" | jq --arg s "$status" '.status = $s')"
  commit_task_change "$id" "$old_content" "$new_content"
  echo "task-state.sh: task $id status -> $status"
}

task_set_phase_status() {
  local id="${1:-}" phase_id="${2:-}" status="${3:-}"
  [ -n "$id" ] && [ -n "$phase_id" ] && [ -n "$status" ] || usage_err "task set-phase-status <id> <phase-id> <STATUS>"
  require_valid_id "$id"
  is_valid_status "$status" || die "invalid status: $status (allowed: ${STATUS_ENUM[*]})"
  local file="$TASKS_DIR/$id.json"
  acquire_lock "$file.lock"
  local old_content
  old_content="$(read_current_task_content "$id")"
  require_phase_exists "$old_content" "$phase_id" "$id"
  local new_content
  new_content="$(printf '%s' "$old_content" | jq --arg p "$phase_id" --arg s "$status" \
    '(.phases | map(.id) | index($p)) as $idx | .phases[$idx].status = $s')"
  commit_task_change "$id" "$old_content" "$new_content"
  echo "task-state.sh: task $id phase $phase_id status -> $status"
}

task_append_history() {
  local id="${1:-}"
  [ -n "$id" ] || usage_err "task append-history <id> <text-or-json> [--value-file <path>]"
  require_valid_id "$id"
  shift
  local raw="" value_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --value-file)
        [ $# -ge 2 ] || usage_err "--value-file requires a path"
        value_file="$2"; shift 2 ;;
      *)
        if [ -z "$raw" ]; then raw="$1"; shift; else usage_err "unexpected argument: $1"; fi ;;
    esac
  done
  [ -n "$raw" ] || [ -n "$value_file" ] || usage_err "task append-history needs <text-or-json> or --value-file"
  [ -z "$raw" ] || [ -z "$value_file" ] || usage_err "specify either <text-or-json> or --value-file, not both"

  local entry_json ty now final_entry
  entry_json="$(to_json_value "$raw" "$value_file")"
  ty="$(printf '%s' "$entry_json" | jq -r 'type')"
  now="$(utc_now)"
  case "$ty" in
    object)
      final_entry="$(printf '%s' "$entry_json" | jq --arg at "$now" 'if has("at") then . else . + {at: $at} end')" ;;
    string)
      final_entry="$(jq -n --arg at "$now" --argjson s "$entry_json" '{at: $at, summary: $s}')" ;;
    *)
      die "history entry must be a JSON object or plain text (got: $ty)" ;;
  esac

  local file="$TASKS_DIR/$id.json"
  acquire_lock "$file.lock"
  local old_content new_content
  old_content="$(read_current_task_content "$id")"
  new_content="$(printf '%s' "$old_content" | jq --argjson e "$final_entry" '.history += [$e]')"
  commit_task_change "$id" "$old_content" "$new_content"
  echo "task-state.sh: task $id history appended"
}

task_set_field() {
  local id="${1:-}" field="${2:-}"
  [ -n "$id" ] && [ -n "$field" ] || usage_err "task set-field <id> <field> [<value>] [--phase <phase-id>] [--value-file <path>]"
  require_valid_id "$id"
  shift 2
  local raw="" value_file="" phase_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --phase)
        [ $# -ge 2 ] || usage_err "--phase requires a phase id"
        phase_id="$2"; shift 2 ;;
      --value-file)
        [ $# -ge 2 ] || usage_err "--value-file requires a path"
        value_file="$2"; shift 2 ;;
      *)
        if [ -z "$raw" ]; then raw="$1"; shift; else usage_err "unexpected argument: $1"; fi ;;
    esac
  done
  [ -n "$raw" ] || [ -n "$value_file" ] || usage_err "task set-field needs <value> or --value-file"
  [ -z "$raw" ] || [ -z "$value_file" ] || usage_err "specify either <value> or --value-file, not both"

  is_mutable_field "$field" \
    || die "field not allowlisted for set-field: '$field' (protected or unknown — allowed: ${MUTABLE_FIELDS[*]}). status/phases[].status use set-status/set-phase-status; history is append-only; phases[].{title,specSectionAnchor,autoContinue}/phases count/id are protected — only 'task replace-unsafe' may change those."

  local value_json
  value_json="$(to_json_value "$raw" "$value_file")"

  local file="$TASKS_DIR/$id.json"
  acquire_lock "$file.lock"
  local old_content
  old_content="$(read_current_task_content "$id")"

  local new_content
  if [ -n "$phase_id" ]; then
    require_phase_exists "$old_content" "$phase_id" "$id"
    new_content="$(printf '%s' "$old_content" | jq --arg p "$phase_id" --arg f "$field" --argjson v "$value_json" \
      '(.phases | map(.id) | index($p)) as $idx | .phases[$idx][$f] = $v')"
  else
    new_content="$(printf '%s' "$old_content" | jq --arg f "$field" --argjson v "$value_json" '.[$f] = $v')"
  fi
  commit_task_change "$id" "$old_content" "$new_content"
  if [ -n "$phase_id" ]; then
    echo "task-state.sh: task $id phase $phase_id field '$field' updated"
  else
    echo "task-state.sh: task $id field '$field' updated"
  fi
}

task_replace_unsafe() {
  local id="${1:-}" new_path="${2:-}"
  [ -n "$id" ] && [ -n "$new_path" ] || usage_err 'task replace-unsafe <id> <new-json-path> --reason "<why>"'
  require_valid_id "$id"
  shift 2
  local reason=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --reason)
        [ $# -ge 2 ] || usage_err "--reason requires text"
        reason="$2"; shift 2 ;;
      *)
        usage_err "unexpected argument: $1" ;;
    esac
  done
  [ -n "$reason" ] || die "--reason is required for replace-unsafe (this is the escape hatch — record WHY the re-plan needs to change protected fields)"

  [ -s "$new_path" ] || die "new JSON file missing or empty: $new_path (invariant 1)"
  jq -e . "$new_path" >/dev/null 2>&1 || die "new JSON file is not valid JSON: $new_path (invariant 1)"

  local file="$TASKS_DIR/$id.json"
  acquire_lock "$file.lock"
  local old_content
  old_content="$(read_current_task_content "$id")"

  # invariant 2 still enforced under replace-unsafe
  local miss
  if miss="$(find_missing_required_key "$(cat "$new_path")")"; then
    die "refusing replace: required top-level key missing: $miss (invariant 2 still enforced under replace-unsafe)"
  fi
  # phases[] must still be a well-formed array (type + per-element required
  # fields) even though replace-unsafe is exempt from invariants 3/4 (count /
  # protected-field changes) — --relax-phases only relaxes commit_task_change's
  # comparison against the OLD file, not the shape of the new one. Without
  # this, a replacement like {"phases":"bad"} would commit and defeat the
  # single-phase "[]" convention and every downstream phases[] consumer.
  validate_phases_shape "$(cat "$new_path")"
  # status must remain a member of STATUS_ENUM and history must remain an
  # array — replace-unsafe is the re-plan escape hatch (protected phase
  # fields / phase count), not a general schema bypass; it must not be able
  # to hand back a task with a nonsense status or a non-array history.
  local new_status
  new_status="$(jq -r '.status' "$new_path")"
  is_valid_status "$new_status" || die "refusing replace: invalid status: $new_status (allowed: ${STATUS_ENUM[*]})"
  [ "$(jq -r '.history | type' "$new_path" 2>/dev/null)" = "array" ] \
    || die "refusing replace: 'history' must be an array"
  # invariant 5 still enforced under replace-unsafe
  local old_id new_id
  old_id="$(printf '%s' "$old_content" | jq -r '.id')"
  new_id="$(jq -r '.id' "$new_path")"
  [ "$old_id" = "$new_id" ] || die "refusing replace: id must not change ($old_id -> $new_id) (invariant 5 still enforced under replace-unsafe)"

  local now final_content
  now="$(utc_now)"
  final_content="$(jq --arg reason "$reason" --arg at "$now" \
    '.history += [{"phase": "replace-unsafe", "at": $at, "summary": ("re-plan escape hatch: " + $reason)}]' \
    "$new_path")"

  echo "=== task-state.sh replace-unsafe: diff for $id (reason: $reason) ==="
  diff -u \
    <(printf '%s' "$old_content" | jq -S .) \
    <(printf '%s' "$final_content" | jq -S .)
  echo "=== end diff ==="

  # invariants 3/4 (phase count / protected phase fields) are intentionally
  # relaxed here — this is the re-plan escape hatch.
  commit_task_change "$id" "$old_content" "$final_content" --relax-phases
  echo "task-state.sh: task $id replaced via replace-unsafe (reason recorded in history)"
}

cmd_task() {
  local sub="${1:-}"
  [ -n "$sub" ] || usage_err "task <create|get|set-status|set-phase-status|append-history|set-field|replace-unsafe> ..."
  shift
  case "$sub" in
    create) task_create "$@" ;;
    get) task_get "$@" ;;
    set-status) task_set_status "$@" ;;
    set-phase-status) task_set_phase_status "$@" ;;
    append-history) task_append_history "$@" ;;
    set-field) task_set_field "$@" ;;
    replace-unsafe) task_replace_unsafe "$@" ;;
    *) usage_err "unknown task subcommand: $sub" ;;
  esac
}

# ============================================================================
# queue subcommands
# ============================================================================

queue_set_current() {
  [ $# -ge 1 ] || usage_err "queue set-current <id|null>"
  local value="$1"
  mkdir -p "$STATE_DIR"
  acquire_lock "$QUEUE_FILE.lock"
  local old_content="{}"
  if [ -f "$QUEUE_FILE" ]; then
    old_content="$(cat "$QUEUE_FILE")"
    if ! is_valid_json_content "$old_content"; then
      die "current queue.json is corrupt (invalid JSON): $QUEUE_FILE — restore from $QUEUE_FILE.bak first"
    fi
  fi
  local json_val
  if [ "$value" = "null" ]; then
    json_val="null"
  else
    json_val="$(jq -Rn --arg v "$value" '$v')"
  fi
  local now new_content
  now="$(utc_now)"
  new_content="$(printf '%s' "$old_content" | jq --argjson v "$json_val" --arg at "$now" '.currentTask = $v | .lastUpdated = $at')"
  if ! is_valid_json_content "$new_content"; then
    die "refusing write: transformed queue content is not valid JSON"
  fi
  write_atomic "$QUEUE_FILE" "$new_content"
  echo "task-state.sh: queue currentTask -> $value"
}

queue_get() {
  [ -f "$QUEUE_FILE" ] || die "queue.json not found: $QUEUE_FILE"
  jq -e . "$QUEUE_FILE" >/dev/null 2>&1 || die "queue.json is corrupt (invalid JSON): $QUEUE_FILE — restore from $QUEUE_FILE.bak"
  jq . "$QUEUE_FILE"
}

cmd_queue() {
  local sub="${1:-}"
  [ -n "$sub" ] || usage_err "queue <set-current|get> ..."
  shift
  case "$sub" in
    set-current) queue_set_current "$@" ;;
    get) queue_get "$@" ;;
    *) usage_err "unknown queue subcommand: $sub" ;;
  esac
}

# ============================================================================
# help
# ============================================================================

print_help() {
  cat <<'EOF'
task-state.sh — allowlisted read/write gateway for .feature-state/tasks/*.json
and .feature-state/queue.json (the crowi-feature pipeline's state files).

WHY THIS EXISTS
  Agents used to Read the whole task JSON, regenerate it in memory, and Write
  it back. That caused two real incidents: a 0-byte truncation, and a silent
  structural rewrite that flipped phases[].autoContinue from false to true
  (defeating a human "needs coordination" gate) while also dropping top-level
  context/openQuestions/history. A PreToolUse hook now blocks Write/Edit on
  these paths outright; this script is the only allowed write path. See
  .feature-state/specs/feature-task-state-script.md for the incident writeup.

ID FORMAT
  Every <id> argument is used to build a path ($TASKS_DIR/<id>.json), so it is
  restricted to lowercase kebab-case (e.g. "feature-foo-bar", matching the
  real .feature-state/tasks/ corpus): letters/digits/hyphens only, must start
  with a letter. No '/', '.', or leading digit/hyphen — this is what stops an
  id like "../../etc/passwd" from escaping .feature-state/tasks/.

SUBCOMMANDS

  task create <id> <draft-json-path>
      Create a brand-new .feature-state/tasks/<id>.json from a draft JSON
      file. Fails if the task already exists (checked twice: once fast-fail
      before validating the draft, and once more — authoritatively — right
      after the lock is acquired, to close the TOCTOU race between two
      concurrent creates for the same id). Validates: draft parses as JSON,
      draft.id matches <id>, all REQUIRED TOP-LEVEL KEYS present (see below,
      including "phases" — must be an array; [] is valid for a task with no
      per-phase breakdown), status is a valid enum value, and every phases[]
      entry (if any) has id/title/specSectionAnchor/autoContinue/status with
      a valid status and unique ids.
      NOTE: write the draft to a path OUTSIDE .feature-state/tasks/ first
      (e.g. your session scratchpad) — the PreToolUse hook blocks Write/Edit
      on any *.json directly under .feature-state/tasks/, including a draft.

  task get <id>
      Pretty-print the current task JSON. Read-only (Read tool works too;
      this is a convenience). Fails if the file is missing or corrupt.

  task set-status <id> <STATUS>
      Set the top-level status. STATUS must be one of:
        PLANNED IN_PROGRESS REVIEW NEEDS_WORK APPROVED COMMITTED
        PARTIALLY_COMMITTED READY_TO_INTEGRATE INTEGRATED

  task set-phase-status <id> <phase-id> <STATUS>
      Set the status of one phases[] entry (matched by its "id", e.g.
      "phase-2"). Same STATUS enum as above. Fails if the phase id doesn't
      exist — does NOT create phases (see "phases" under PROTECTED below).

  task append-history <id> <text-or-json> [--value-file <path>]
      Append ONE entry to the history[] array (never replaces/removes
      existing entries). If <text-or-json> parses as a JSON object, it is
      appended as-is (an "at" UTC timestamp is auto-added if missing so you
      don't have to compute it). Plain text is wrapped as
      {"at": <now>, "summary": <text>}. Use --value-file for a large/complex
      JSON object instead of an inline arg.

  task set-field <id> <field> [<value>] [--phase <phase-id>] [--value-file <path>]
      Set one allowlisted field, either top-level or (with --phase) on the
      phases[] entry matching that phase id. <value> is used as JSON if it
      parses as JSON (object/array/number/bool/null/quoted-string), otherwise
      it is wrapped as a JSON string. Use --value-file for large payloads
      (recommended for context / commitPlan / reviewFeedback / readyForMerge
      / commitInfo — write them to a scratch file first, NOT under
      .feature-state/tasks/).

      MUTABLE (allowlisted) fields:
        name description priority scope stack dependencies context
        acceptanceCriteria openQuestions outOfScope commitPlan commitInfo
        reviewFeedback reviewAttempts readyForMerge currentPhase commitShas
        origin integratedAt integratedMergeCommit integratedVia
        implementationNotes decisions blockedOn

      NOT settable via set-field (use the dedicated subcommand, or
      replace-unsafe for a legitimate re-plan):
        status, phases[].status  -> set-status / set-phase-status
        history                  -> append-history (append-only)
        id                       -> never (invariant 5)
        phases (the array itself, incl. adding/removing elements),
        phases[].title, phases[].specSectionAnchor, phases[].autoContinue
                                  -> protected (invariants 3/4); only
                                     'task replace-unsafe' may change these

  task replace-unsafe <id> <new-json-path> --reason "<why>"
      The re-plan ESCAPE HATCH: the only way to change phases[] element
      count or phases[].{title,specSectionAnchor,autoContinue} (invariants
      3/4 are relaxed here). Invariants 1 (valid JSON), 2 (required
      top-level keys), and 5 (id unchanged) are still enforced — this is not
      a way to write garbage or rename a task. --reason is mandatory and is
      auto-appended to history as a "replace-unsafe" entry. Prints a full
      unified diff (old vs new) to stdout before writing so the change is
      always visible in the transcript/log.

  queue set-current <id|null>
      Set .feature-state/queue.json's currentTask (and lastUpdated). Creates
      queue.json if missing. Pass the literal string "null" to clear it.

  queue get
      Pretty-print the current queue.json.

INVARIANTS (checked on every write; violation -> non-zero exit, ORIGINAL
FILE LEFT COMPLETELY UNTOUCHED — no tmp file is ever renamed into place
unless every check below passes)

  1. The transformed content must parse as JSON (jq -e .) — rules out
     0-byte / truncated / syntactically broken writes structurally.
  2. Required top-level keys (id, name, status, scope, context,
     openQuestions, history, phases) must all still be present — "phases"
     is required so a re-plan can never silently drop the whole phase
     structure ([] is valid for a task with no per-phase breakdown).
  3. phases[] element count must be unchanged.        (replace-unsafe only exempt)
  4. Each phases[i].{title,specSectionAnchor,autoContinue} (matched by id)
     must be unchanged.                                (replace-unsafe only exempt)
  5. id must be unchanged.                              (never exempt, even
                                                          under replace-unsafe)

ATOMICITY + RECOVERY
  Every successful write: jq transform -> <file>.tmp -> reparse-validate ->
  copy CURRENT <file> to <file>.bak (1 generation, overwritten each time) ->
  atomic rename tmp over <file>. If any step fails (tmp write, tmp
  validation, backup, or the rename itself) the .tmp file is discarded and
  <file>/<file>.bak are left completely untouched — a failed write never
  leaves a partial/leftover .tmp behind and never proceeds without a fresh
  backup. If you ever find <file> corrupt or unexpectedly changed:
    cp "<file>.bak" "<file>"      # restore the last known-good version
    jq . "<file>"                 # verify it parses and looks right
  Then retry your task-state.sh command. task-state.sh itself refuses to
  operate on an already-corrupt current file (fails loudly instead of
  writing on top of it) — you must restore it first.

LOCKING
  Each write acquires a short noclobber lock (<file>.lock) and releases it on
  exit (success or failure). A busy lock fails immediately (non-zero exit,
  holder JSON printed) — it does not wait/retry. This serializes concurrent
  writers to the SAME task/queue file within one process tree; it is not a
  cross-worktree lock (worktrees normally touch different task ids).

EXIT CODES
  0  success
  1  operation failed (invariant violation, not found, corrupt file, lock busy)
  2  usage error (missing/invalid arguments, unknown subcommand)

TESTING
  bash .claude/scripts/task-state.test.sh
  Runs an isolated smoke-test suite (via TASK_STATE_STATE_DIR pointing at a
  temp dir) — never touches the real .feature-state/.

EXAMPLES
  bash .claude/scripts/task-state.sh task set-status feature-foo IN_PROGRESS
  bash .claude/scripts/task-state.sh task append-history feature-foo "planning done"
  bash .claude/scripts/task-state.sh task set-field feature-foo commitPlan --value-file /tmp/commit-plan.json
  bash .claude/scripts/task-state.sh task set-phase-status feature-foo phase-2 REVIEW
  bash .claude/scripts/task-state.sh task replace-unsafe feature-foo /tmp/replan.json --reason "spec revised: split phase 3 into 3a/3b"
  bash .claude/scripts/task-state.sh queue set-current feature-foo
  bash .claude/scripts/task-state.sh queue set-current null
EOF
}

# ============================================================================
# main
# ============================================================================

main() {
  require_jq
  local cmd="${1:-}"
  case "$cmd" in
    -h | --help | help | "") print_help ;;
    task) shift; cmd_task "$@" ;;
    queue) shift; cmd_queue "$@" ;;
    *) usage_err "unknown command: $cmd (want 'task', 'queue', or --help)" ;;
  esac
}

main "$@"
