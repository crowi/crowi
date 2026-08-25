#!/usr/bin/env bash

set -u

usage() {
  echo "usage: validate-implementation-spec.sh [--structure-only] <spec-path>" >&2
  exit 2
}

# --structure-only: grounded_at の staleness 検査 (参照 path が grounded_at 以降に
# 変わっていないこと) だけをスキップし、構造検証はすべて行う。resume した実装
# パイプラインが provenance を再検証する用途 — 先行 phase が参照 path を計画どおり
# 変更した後では、full の staleness 検査は必ず偽陽性になるため。
STRUCTURE_ONLY=0
if [[ "${1:-}" == "--structure-only" ]]; then
  STRUCTURE_ONLY=1
  shift
fi

[[ "$#" -eq 1 ]] || usage

SPEC_PATH="$1"
if [[ ! -f "$SPEC_PATH" ]]; then
  echo "ERROR: spec not found: $SPEC_PATH" >&2
  exit 1
fi

ERRORS=()
WARNINGS=()

add_error() {
  ERRORS+=("$1")
}

add_warning() {
  WARNINGS+=("$1")
}

# invocation-private scratch space for blob reads and matching-line output.
# Reused (overwritten) across paths/symbols rather than named per path/symbol,
# since processing is sequential and the performance contract only promises
# "linear in the 2 blobs + matching outputs being processed concurrently" —
# not one file per path or symbol.
STALENESS_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/crowi-spec-staleness.XXXXXX" 2>/dev/null)"
if [[ -z "$STALENESS_TMP_DIR" || ! -d "$STALENESS_TMP_DIR" ]]; then
  echo "ERROR: staleness check failed: unable to create a temp directory" >&2
  exit 1
fi
trap 'rm -rf "$STALENESS_TMP_DIR"' EXIT
GROUNDED_BLOB_FILE="$STALENESS_TMP_DIR/grounded-blob"
HEAD_BLOB_FILE="$STALENESS_TMP_DIR/head-blob"
GROUNDED_MATCH_FILE="$STALENESS_TMP_DIR/grounded-match"
HEAD_MATCH_FILE="$STALENESS_TMP_DIR/head-match"

# VALIDATION_HEAD is the single fixed commit every committed-side comparison
# in this invocation uses instead of a live "HEAD" — a standalone leaf fixes
# it once at start; an umbrella fixes it once and hands it to every child via
# CROWI_SPEC_VALIDATION_HEAD so a single invocation never compares two
# children against two different HEADs. The env var is internal (umbrella ->
# child) but is validated fully regardless of who sets it: it must be a full
# commit object id that resolves to a real commit, otherwise it is rejected
# exactly like a missing worktree.
VALIDATION_HEAD=""
resolve_validation_head() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    add_error "freshness check requires a git worktree"
    return
  fi
  if [[ -n "${CROWI_SPEC_VALIDATION_HEAD:-}" ]]; then
    local supplied="$CROWI_SPEC_VALIDATION_HEAD"
    if [[ ! "$supplied" =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]]; then
      add_error "CROWI_SPEC_VALIDATION_HEAD must be a full commit object id"
      return
    fi
    if ! git cat-file -e "${supplied}^{commit}" >/dev/null 2>&1; then
      add_error "CROWI_SPEC_VALIDATION_HEAD does not resolve to a commit: $supplied"
      return
    fi
    VALIDATION_HEAD="$supplied"
  else
    VALIDATION_HEAD="$(git rev-parse HEAD 2>/dev/null)"
    if [[ -z "$VALIDATION_HEAD" ]]; then
      add_error "staleness check failed: unable to resolve HEAD"
    fi
  fi
}
resolve_validation_head

# recheck_validation_head_unchanged: re-reads HEAD and records an error if it
# no longer matches VALIDATION_HEAD. Callers only invoke this once every
# earlier check has passed (no error recorded yet) — a stale HEAD found now
# means something moved HEAD during this invocation, which invalidates every
# comparison already made against VALIDATION_HEAD.
recheck_validation_head_unchanged() {
  local recheck_head
  recheck_head="$(git rev-parse HEAD 2>/dev/null)"
  if [[ -z "$recheck_head" ]]; then
    add_error "staleness check failed: unable to re-read HEAD"
  elif [[ "$recheck_head" != "$VALIDATION_HEAD" ]]; then
    add_error "staleness check failed: HEAD changed during validation; rerun validator"
  fi
}

# read_tree_entry <commit> <path>: prints the path's tree-entry mode at
# <commit> (the blob object id is never needed by any caller, so it is not
# part of this contract). Exit 0 = found (output populated); a non-regular
# mode (submodule/tree/symlink) is a normal, expected output here — the
# caller decides what a mode means, this only does the checked read. Exit 1 =
# `git ls-tree` ran fine but the path has no entry at that commit (the path
# does not exist there — a legitimate mode-mismatch-shaped condition, not an
# inspection failure). Exit 2 = `git ls-tree` itself failed to execute; the
# caller must treat that as inspection-failed, not as a mode mismatch, per
# the "git/od/cmp の実行失敗は判定不能 ERROR" contract.
read_tree_entry() {
  local commit="$1" path="$2" line status
  line="$(git ls-tree "$commit" -- "$path" 2>/dev/null)"
  status=$?
  [[ "$status" -eq 0 ]] || return 2
  [[ -n "$line" ]] || return 1
  awk '{print $1}' <<<"$line"
}

# read_git_blob <commit> <path> <output>: checked read of a blob into a
# normal file. Failure (missing path, git error) is the caller's signal to
# treat the path as inspection-failed rather than silently comparing empty
# content.
read_git_blob() {
  local commit="$1" path="$2" output="$3"
  git show "${commit}:${path}" >"$output" 2>/dev/null
}

# blob_has_nul <file>: 0 = contains a NUL byte (binary), 1 = no NUL byte
# (text), 2 = could not be inspected. Detected via od byte tokens rather than
# a shell-variable NUL search because bash strings cannot hold a NUL byte at
# all, so no shell-level comparison could ever see one.
blob_has_nul() {
  local file="$1"
  LC_ALL=C od -An -v -tx1 -- "$file" 2>/dev/null | grep -qw '00'
  # Capture the whole array in one assignment: each subsequent simple command
  # (including a second `local` line) overwrites PIPESTATUS with its own
  # single-command result, so reading od's and grep's status via two
  # separate `local` assignments would silently lose the first one.
  local statuses=("${PIPESTATUS[@]}")
  local od_status="${statuses[0]}"
  local grep_status="${statuses[1]}"
  [[ "$od_status" -eq 0 ]] || return 2
  case "$grep_status" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

# extract_matching_lines <input> <symbol> <output>: writes the fixed-string
# matching-line sequence to <output> and returns grep's exit status (0 =
# non-empty sequence, 1 = empty sequence — both normal; >=2 is
# inspection-failed, handled by the caller).
extract_matching_lines() {
  local input="$1" symbol="$2" output="$3"
  LC_ALL=C grep -F -- "$symbol" "$input" >"$output" 2>/dev/null
}

frontmatter_value_of() {
  local path="$1"
  local key="$2"
  awk -v key="$key" '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter && index($0, key ":") == 1 {
      sub("^[^:]+:[[:space:]]*", "")
      gsub(/^["'\'']|["'\'']$/, "")
      print
      exit
    }
  ' "$path"
}

frontmatter_value() {
  frontmatter_value_of "$SPEC_PATH" "$1"
}

section_has_content() {
  local japanese="$1"
  local english="$2"
  awk -v ja="$japanese" -v en="$english" '
    /^## / {
      if (in_section) exit
      heading = $0
      sub(/^## /, "", heading)
      if (index(heading, ja) == 1 || index(heading, en) == 1) {
        in_section = 1
        next
      }
    }
    in_section && $0 !~ /^[[:space:]]*$/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$SPEC_PATH"
}

require_section() {
  local japanese="$1"
  local english="$2"
  local label="$3"
  if ! section_has_content "$japanese" "$english"; then
    add_error "missing or empty section: $label"
  fi
}

SPEC_CONTRACT="$(frontmatter_value spec_contract)"
IMPLEMENTATION_READY="$(frontmatter_value implementation_ready)"
GROUNDED_AT="$(frontmatter_value grounded_at)"
ID="$(frontmatter_value id)"
NAME="$(frontmatter_value name)"
SCOPE="$(frontmatter_value scope)"
STATUS="$(frontmatter_value status)"
KIND="$(frontmatter_value kind)"

# ---------------------------------------------------------------------------
# Umbrella specs (`kind: umbrella`)
# ---------------------------------------------------------------------------
# An umbrella carries only the operational contract (single worktree, one
# integration at the end) and the phase table; the implementable substance
# lives in the phase specs it lists. So it cannot satisfy the leaf checks
# below — it has no AC, no implementation map, and no grounding of its own.
#
# The v2 strictness is DELEGATED, not dropped: every phase listed under
# `phases:` must exist and pass this validator in full. That keeps the kickoff
# guarantee ("no design decisions left to a cheap model") intact while letting
# the umbrella stay what it is.
#
# Phases are read from frontmatter rather than the prose phase table on
# purpose. Parsing the table would make the set of validated specs depend on
# markdown formatting, and its failure mode is the worst kind: a reformatted
# table silently yields zero phases and the umbrella passes having verified
# nothing. The table stays as human-facing documentation.
if [[ "$KIND" == "umbrella" ]]; then
  [[ "$SPEC_CONTRACT" == "2" ]] || add_error "frontmatter spec_contract must be 2"
  [[ "$STATUS" == "approved" ]] || add_error "frontmatter status must be approved"
  [[ "$ID" =~ ^feature-[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    add_error "frontmatter id must match feature-<kebab-slug>"

  SPEC_DIR="$(cd "$(dirname "$SPEC_PATH")" && pwd)"
  VALIDATOR="${BASH_SOURCE[0]}"

  PHASES=()
  while IFS= read -r phase; do
    [[ -n "$phase" ]] && PHASES+=("$phase")
  done < <(awk '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter && $0 ~ /^phases:[[:space:]]*$/ { in_phases = 1; next }
    in_phases && $0 ~ /^[[:space:]]+-[[:space:]]+[^[:space:]]/ {
      item = $0
      sub(/^[[:space:]]+-[[:space:]]+/, "", item)
      gsub(/^["'\'']|["'\'']$/, "", item)
      sub(/[[:space:]]+$/, "", item)
      print item
      next
    }
    in_phases { exit }
  ' "$SPEC_PATH")

  if [[ "${#PHASES[@]}" -eq 0 ]]; then
    add_error "umbrella spec must list phases as a frontmatter block sequence (phases:\\n  - feature-...)"
  else
    SEEN_PHASES=""
    VALIDATED_PHASES=0
    for phase in "${PHASES[@]}"; do
      # Phases are spec IDs, not paths. Requiring the ID form is what keeps an
      # umbrella pointing at its own sibling specs: a value like
      # `../elsewhere/unrelated` would otherwise resolve and let an umbrella
      # claim delegation to a spec that is not one of its phases at all.
      if [[ ! "$phase" =~ ^feature-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
        add_error "umbrella phase must be a spec id matching feature-<kebab-slug>: $phase"
        continue
      fi
      # A repeated phase would be validated twice and counted twice, so the
      # summary would claim more distinct specs were verified than actually were.
      case " $SEEN_PHASES " in
        *" $phase "*)
          add_error "umbrella phase listed more than once: $phase"
          continue
          ;;
      esac
      SEEN_PHASES="$SEEN_PHASES $phase"
      phase_path="$SPEC_DIR/$phase.md"
      if [[ ! -f "$phase_path" ]]; then
        add_error "umbrella phase spec not found: $phase"
        continue
      fi
      # Nested umbrellas are refused rather than recursed into: it keeps the
      # delegation one level deep (so a cycle cannot exist) and no real spec
      # has ever needed more.
      if [[ "$(frontmatter_value_of "$phase_path" kind)" == "umbrella" ]]; then
        add_error "umbrella phase must be an implementation spec, not another umbrella: $phase"
        continue
      fi
      phase_stderr_file="$STALENESS_TMP_DIR/phase-stderr-$phase"
      : >"$phase_stderr_file"
      phase_structure_only_flag=""
      [[ "$STRUCTURE_ONLY" -eq 1 ]] && phase_structure_only_flag="--structure-only"
      if ! CROWI_SPEC_VALIDATION_HEAD="$VALIDATION_HEAD" bash "$VALIDATOR" ${phase_structure_only_flag:+"$phase_structure_only_flag"} "$phase_path" >/dev/null 2>"$phase_stderr_file"; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && add_error "phase $phase: ${line#ERROR: }"
        done <"$phase_stderr_file"
      else
        VALIDATED_PHASES=$((VALIDATED_PHASES + 1))
        while IFS= read -r line; do
          [[ "$line" == WARN:\ * ]] && add_warning "phase $phase: ${line#WARN: }"
        done <"$phase_stderr_file"
      fi
    done
  fi

  # A phase-level failure already means "not ready"; re-checking our own HEAD
  # cannot change that outcome, so it only runs on the success path. Skipped
  # under --structure-only along with every other freshness recheck.
  if [[ "${#ERRORS[@]}" -eq 0 && "$STRUCTURE_ONLY" -eq 0 && -n "$VALIDATION_HEAD" ]]; then
    recheck_validation_head_unchanged
  fi

  if [[ "${#ERRORS[@]}" -gt 0 ]]; then
    for error in "${ERRORS[@]}"; do
      echo "ERROR: $error" >&2
    done
    exit 1
  fi
  for warning in "${WARNINGS[@]}"; do
    echo "WARN: $warning" >&2
  done
  echo "READY: umbrella spec v2 ($SPEC_PATH) — $VALIDATED_PHASES phase specs validated"
  exit 0
fi

[[ "$SPEC_CONTRACT" == "2" ]] || add_error "frontmatter spec_contract must be 2"
[[ "$IMPLEMENTATION_READY" == "true" ]] || add_error "frontmatter implementation_ready must be true"
[[ "$STATUS" == "approved" ]] || add_error "frontmatter status must be approved"
[[ "$ID" =~ ^feature-[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
  add_error "frontmatter id must match feature-<kebab-slug>"
[[ -n "$NAME" ]] || add_error "frontmatter name must be non-empty"
case "$SCOPE" in
  trivial|small|medium|large) ;;
  *) add_error "frontmatter scope must be one of: trivial, small, medium, large" ;;
esac
if [[ ! "$GROUNDED_AT" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  add_error "frontmatter grounded_at must be a git commit SHA"
fi

require_section "背景 / why" "Background / why" "背景 / why"
require_section "やること (ユーザー視点)" "User-visible behavior" "やること (ユーザー視点)"
require_section "やらないこと (out of scope)" "Out of scope" "やらないこと (out of scope)"
require_section "設計の主な判断" "Key design decisions" "設計の主な判断"
require_section "実装マップ" "Implementation map" "実装マップ (implementation map)"
require_section "処理・データフロー" "Control / data flow" "処理・データフロー (control / data flow)"
require_section "契約・不変条件" "Contracts / invariants" "契約・不変条件 (contracts / invariants)"
require_section "受け入れ基準" "Acceptance criteria" "受け入れ基準 (acceptance criteria)"
require_section "テスト計画" "Test plan" "テスト計画 (test plan)"
require_section "実装順序" "Implementation order" "実装順序 (implementation order)"
require_section "未確定事項" "Open questions" "未確定事項 (open questions)"

MAP_ERRORS="$(awk '
  function flush_change() {
    if (!in_change) return
    if (!has_status) print "implementation map entry " change_path " is missing status"
    if (!has_symbols) print "implementation map entry " change_path " is missing symbols"
    if (!has_changes) print "implementation map entry " change_path " is missing changes"
    if (!has_reuse) print "implementation map entry " change_path " is missing reuse"
  }
  /^### Change: `/ {
    flush_change()
    in_change = 1
    change_path = $0
    sub(/^### Change: `/, "", change_path)
    sub(/`.*/, "", change_path)
    change_count++
    has_status = has_symbols = has_changes = has_reuse = 0
    next
  }
  in_change && /^- status:[[:space:]]*(existing|new)[[:space:]]*$/ { has_status = 1; next }
  in_change && /^- symbols:[[:space:]]*`[^`]+/ { has_symbols = 1; next }
  in_change && /^- changes:[[:space:]]*[^[:space:]]/ { has_changes = 1; next }
  in_change && /^- reuse:[[:space:]]*[^[:space:]]/ { has_reuse = 1; next }
  END {
    flush_change()
    if (change_count == 0) print "implementation map must contain at least one ### Change: `path` entry"
  }
' "$SPEC_PATH")"
if [[ -n "$MAP_ERRORS" ]]; then
  while IFS= read -r error; do
    [[ -n "$error" ]] && add_error "$error"
  done <<<"$MAP_ERRORS"
fi

CHANGE_PATHS=()
REFERENCE_PATHS=()
REFERENCE_SYMBOLS=()
declare -A SEEN_REFERENCE_PAIRS=()

# add_reference <path> <symbol>: registers a freshness reference. <symbol>
# empty means a strict (path-only) record; non-empty means a symbol record
# for that path. Exact (path, symbol) pairs are deduped so a symbol named by
# both a Change entry and a reuse target isn't checked twice.
add_reference() {
  local path="$1" symbol="$2" key
  key="$path"$'\x1f'"$symbol"
  [[ -n "${SEEN_REFERENCE_PAIRS[$key]:-}" ]] && return
  SEEN_REFERENCE_PAIRS["$key"]=1
  REFERENCE_PATHS+=("$path")
  REFERENCE_SYMBOLS+=("$symbol")
}

is_repo_relative_path() {
  local path="$1"
  case "$path" in
    ""|/*|../*|*/../*|*/..)
      return 1
      ;;
    # A leading ':' is git pathspec magic, not a filename. Left through, a path
    # like ':(exclude)**' would be interpreted by git rather than matched
    # literally, and an exclude-only pathspec makes the staleness diff cover
    # nothing — the spec would pass having checked no files at all.
    :*)
      return 1
      ;;
  esac
  return 0
}

while IFS=$'\034' read -r path status symbols reuse; do
  [[ -z "$path" ]] && continue
  CHANGE_PATHS+=("$path")

  if ! is_repo_relative_path "$path"; then
    add_error "implementation map path must be repository-relative: $path"
    continue
  fi

  if [[ "$status" == "existing" ]]; then
    if [[ ! -f "$path" ]]; then
      add_error "existing implementation map path does not exist: $path"
    else
      while IFS= read -r symbol; do
        [[ -z "$symbol" ]] && continue
        if ! grep -Fq -- "$symbol" "$path"; then
          add_error "existing symbol is not grounded in $path: $symbol"
        fi
        # Registered as a symbol record even if ungrounded: an ungrounded
        # symbol already fails the invocation via the error above, so this
        # only affects output on a path that would otherwise error anyway.
        add_reference "$path" "$symbol"
      done < <(
        awk -F'`' '{ for (i = 2; i <= NF; i += 2) print $i }' <<<"$symbols"
      )
    fi
  elif [[ "$status" == "new" ]]; then
    if [[ -e "$path" ]]; then
      add_error "implementation map marks an existing path as new: $path"
    fi
    # Change status: new is always a strict record (design decision 2) — a
    # not-yet-created path has no symbol lines to compare, and freshness for
    # it just falls back to the existing diff/dirty check like any strict
    # reference.
    add_reference "$path" ""
  fi

  reuse_lower="$(printf '%s' "$reuse" | tr '[:upper:]' '[:lower:]')"
  if [[ "$reuse_lower" == none* ]]; then
    if [[ ! "$reuse" =~ ^none[[:space:]]*[—-][[:space:]]*[^[:space:]] ]]; then
      add_error "reuse: none must include a reason for $path"
    fi
    continue
  fi

  reuse_count=0
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    reuse_count=$((reuse_count + 1))
    reuse_path="${target%%#*}"
    reuse_symbol=""
    if [[ "$target" == *"#"* ]]; then
      reuse_symbol="${target#*#}"
    fi
    if ! is_repo_relative_path "$reuse_path"; then
      add_error "reuse path must be repository-relative: $reuse_path"
      continue
    fi
    if [[ ! -f "$reuse_path" ]]; then
      add_error "reuse path does not exist: $reuse_path"
    else
      if [[ -n "$reuse_symbol" ]] && ! grep -Fq -- "$reuse_symbol" "$reuse_path"; then
        add_error "reuse symbol is not grounded in $reuse_path: $reuse_symbol"
      fi
      # path#symbol -> symbol record, path-only -> strict record (design
      # decision 2). Registered even if the symbol above failed to ground —
      # that already fails the invocation via the error, so this only
      # affects output on a path that would otherwise error anyway.
      add_reference "$reuse_path" "$reuse_symbol"
    fi
  done < <(
    awk -F'`' '{ for (i = 2; i <= NF; i += 2) print $i }' <<<"$reuse"
  )
  if [[ "$reuse_count" -eq 0 ]]; then
    add_error "reuse must name a backticked path#symbol or use none — <reason> for $path"
  fi
done < <(
  awk '
    function flush_change() {
      if (!in_change) return
      print path sep status sep symbols sep reuse
    }
    BEGIN { sep = sprintf("%c", 28) }
    /^### Change: `/ {
      flush_change()
      in_change = 1
      path = $0
      sub(/^### Change: `/, "", path)
      sub(/`.*/, "", path)
      status = symbols = reuse = ""
      next
    }
    in_change && /^- status:/ {
      status = $0
      sub(/^- status:[[:space:]]*/, "", status)
      next
    }
    in_change && /^- symbols:/ {
      symbols = $0
      sub(/^- symbols:[[:space:]]*/, "", symbols)
      next
    }
    in_change && /^- reuse:/ {
      reuse = $0
      sub(/^- reuse:[[:space:]]*/, "", reuse)
      next
    }
    END { flush_change() }
  ' "$SPEC_PATH"
)

CONTRACT_ERRORS="$(awk '
  function check_na_reason(line, label, value) {
    value = line
    sub(/^[^:]+:[[:space:]]*/, "", value)
    value = tolower(value)
    if (value ~ /^(n\/a|not applicable)/ &&
        value !~ /^(n\/a|not applicable)[[:space:]]*[—-][[:space:]]*[^[:space:]]/) {
      print "contracts / invariants " label " must use n/a — <reason> (or n/a - <reason>)"
    }
  }
  /^## / {
    if (in_section) exit
    heading = $0
    sub(/^## /, "", heading)
    if (index(heading, "契約・不変条件") == 1 || index(heading, "Contracts / invariants") == 1) {
      in_section = 1
      next
    }
  }
  in_section {
    if ($0 ~ /^- (公開型・関数・API request\/response|Public API\/types):[[:space:]]*[^[:space:]]/) {
      public_api = 1
      check_na_reason($0, "Public API/types")
    }
    if ($0 ~ /^- Authentication\/authorization:[[:space:]]*[^[:space:]]/) {
      auth = 1
      check_na_reason($0, "Authentication/authorization")
    }
    if ($0 ~ /^- Validation:[[:space:]]*[^[:space:]]/) {
      validation = 1
      check_na_reason($0, "Validation")
    }
    if ($0 ~ /^- Error semantics:[[:space:]]*[^[:space:]]/) {
      errors = 1
      check_na_reason($0, "Error semantics")
    }
    if ($0 ~ /^- Transaction\/concurrency:[[:space:]]*[^[:space:]]/) {
      transaction = 1
      check_na_reason($0, "Transaction/concurrency")
    }
    if ($0 ~ /^- Backward compatibility[[:space:]]*\/[[:space:]]*migration:[[:space:]]*[^[:space:]]/) {
      compatibility = 1
      check_na_reason($0, "Backward compatibility/migration")
    }
    if ($0 ~ /^- Performance\/resource limit:[[:space:]]*[^[:space:]]/) {
      performance = 1
      check_na_reason($0, "Performance/resource limit")
    }
  }
  END {
    if (!public_api) print "contracts / invariants is missing Public API/types"
    if (!auth) print "contracts / invariants is missing Authentication/authorization"
    if (!validation) print "contracts / invariants is missing Validation"
    if (!errors) print "contracts / invariants is missing Error semantics"
    if (!transaction) print "contracts / invariants is missing Transaction/concurrency"
    if (!compatibility) print "contracts / invariants is missing Backward compatibility/migration"
    if (!performance) print "contracts / invariants is missing Performance/resource limit"
  }
' "$SPEC_PATH")"
if [[ -n "$CONTRACT_ERRORS" ]]; then
  while IFS= read -r error; do
    [[ -n "$error" ]] && add_error "$error"
  done <<<"$CONTRACT_ERRORS"
fi

AC_IDS="$(sed -n 's/^- \[[ xX]\] \(AC-[A-Za-z0-9._-]*\):.*/\1/p' "$SPEC_PATH")"
DUPLICATE_AC_IDS="$(printf '%s\n' "$AC_IDS" | sed '/^$/d' | sort | uniq -d)"
if [[ -n "$DUPLICATE_AC_IDS" ]]; then
  while IFS= read -r ac_id; do
    [[ -n "$ac_id" ]] && add_error "duplicate acceptance criterion ID: $ac_id"
  done <<<"$DUPLICATE_AC_IDS"
fi

TEST_AC_IDS=""
TEST_ROW_ERRORS=""
while IFS=$'\034' read -r ac_id test_file test_case test_level; do
  [[ -z "$ac_id" ]] && continue
  TEST_AC_IDS="${TEST_AC_IDS}${TEST_AC_IDS:+$'\n'}${ac_id}"
  if [[ -z "$test_file" ]]; then
    TEST_ROW_ERRORS="${TEST_ROW_ERRORS}${TEST_ROW_ERRORS:+$'\n'}test plan $ac_id has an empty Test file"
  else
    test_file="${test_file#\`}"
    test_file="${test_file%\`}"
    if ! is_repo_relative_path "$test_file"; then
      TEST_ROW_ERRORS="${TEST_ROW_ERRORS}${TEST_ROW_ERRORS:+$'\n'}test plan Test file must be repository-relative for $ac_id: $test_file"
    else
      # Test file is always a strict record (design decision 2) — freshness
      # for it stays the existing whole-file diff/dirty check.
      add_reference "$test_file" ""
    fi
  fi
  if [[ -z "$test_case" ]]; then
    TEST_ROW_ERRORS="${TEST_ROW_ERRORS}${TEST_ROW_ERRORS:+$'\n'}test plan $ac_id has an empty Case"
  fi
  if [[ -z "$test_level" ]]; then
    TEST_ROW_ERRORS="${TEST_ROW_ERRORS}${TEST_ROW_ERRORS:+$'\n'}test plan $ac_id has an empty Level"
  fi
done < <(
  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    BEGIN { sep = sprintf("%c", 28) }
    /^## / {
      if (in_section) exit
      heading = $0
      sub(/^## /, "", heading)
      if (index(heading, "テスト計画") == 1 || index(heading, "Test plan") == 1) {
        in_section = 1
        next
      }
    }
    in_section && /^\|[[:space:]]*AC-[A-Za-z0-9._-]*[[:space:]]*\|/ {
      count = split($0, cell, "|")
      ac = trim(cell[2])
      file = count >= 3 ? trim(cell[3]) : ""
      test_case = count >= 4 ? trim(cell[4]) : ""
      level = count >= 5 ? trim(cell[5]) : ""
      print ac sep file sep test_case sep level
    }
  ' "$SPEC_PATH"
)
if [[ -n "$TEST_ROW_ERRORS" ]]; then
  while IFS= read -r error; do
    [[ -n "$error" ]] && add_error "$error"
  done <<<"$TEST_ROW_ERRORS"
fi

if [[ -z "$AC_IDS" ]]; then
  add_error "acceptance criteria must use stable IDs such as AC-1"
else
  while IFS= read -r ac_id; do
    [[ -z "$ac_id" ]] && continue
    if ! grep -Fqx -- "$ac_id" <<<"$TEST_AC_IDS"; then
      add_error "test plan is missing a mapping for $ac_id"
    fi
  done <<<"$AC_IDS"
fi

while IFS= read -r test_ac_id; do
  [[ -z "$test_ac_id" ]] && continue
  if ! grep -Fqx -- "$test_ac_id" <<<"$AC_IDS"; then
    add_error "test plan references an undeclared acceptance criterion: $test_ac_id"
  fi
done <<<"$TEST_AC_IDS"

OPEN_QUESTION_ERRORS="$(awk '
  /^## / {
    if (in_section) exit
    heading = $0
    sub(/^## /, "", heading)
    if (index(heading, "未確定事項") == 1 || index(heading, "Open questions") == 1) {
      in_section = 1
      next
    }
  }
  in_section && $0 !~ /^[[:space:]]*$/ {
    item = $0
    lowered = tolower(item)
    if (item !~ /^- (なし|無し)[[:space:]]*$/ &&
        lowered !~ /^- none[[:space:]]*$/ &&
        item !~ /^- .+→[[:space:]]*既定:[[:space:]]*[^[:space:]]/ &&
        lowered !~ /^- .+(—|-)[[:space:]]*default:[[:space:]]*[^[:space:]]/) {
      sub(/^- /, "", item)
      print "blocking open question: " item
    }
  }
' "$SPEC_PATH")"
if [[ -n "$OPEN_QUESTION_ERRORS" ]]; then
  while IFS= read -r error; do
    [[ -n "$error" ]] && add_error "$error"
  done <<<"$OPEN_QUESTION_ERRORS"
fi

if [[ "$GROUNDED_AT" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  if [[ -z "$VALIDATION_HEAD" ]]; then
    : # resolve_validation_head already recorded why (no worktree / bad env var).
  elif ! git cat-file -e "${GROUNDED_AT}^{commit}" >/dev/null 2>&1; then
    add_error "grounded_at commit does not exist: $GROUNDED_AT"
  elif ! git merge-base --is-ancestor "$GROUNDED_AT" "$VALIDATION_HEAD" >/dev/null 2>&1; then
    add_error "spec is stale: grounded_at is not an ancestor of HEAD"
  elif [[ "$STRUCTURE_ONLY" -eq 1 ]]; then
    : # structure-only: grounded_at 自体の存在・ancestry は確認済み。ここから先の
      # 「参照 path が grounded_at 以降に変わっていないか」の diff/dirty 検査だけを
      # 飛ばす (resume 時、先行 phase がその path を計画どおり変更済みのため)。
  elif [[ "${#REFERENCE_PATHS[@]}" -gt 0 ]]; then
    # Generated artifacts are excluded from the staleness check. The check
    # exists to detect "the code this spec reasoned about has moved"; a
    # regenerated lockfile or OpenAPI document means someone else ran a build,
    # not that any design premise became invalid. Left in, they make every
    # spec that touches api-contract or dependencies go stale on unrelated
    # work, and no amount of re-grounding fixes it — the next regeneration
    # stales them again.
    #
    # Matching on path rather than on an author-declared marker is deliberate:
    # whether a file is generated is an objective property of its path, so
    # this applies retroactively to specs already written and cannot be
    # forgotten by whoever writes the next one.
    GENERATED_ARTIFACT_RE='(^|/)(pnpm-lock\.yaml|openapi\.(json|yaml))$|(^|/)generated/'
    UNIQUE_REFERENCE_PATHS=()
    while IFS= read -r path; do
      [[ -n "$path" ]] && UNIQUE_REFERENCE_PATHS+=("$path")
    done < <(printf '%s\n' "${REFERENCE_PATHS[@]}" | awk '!seen[$0]++' |
      grep -Ev "$GENERATED_ARTIFACT_RE" || true)

    # Per-path strict/symbol categorization (design decision 2): a path with
    # even one strict (empty-symbol) record is strict as a whole — symbol
    # granularity never applies to it, mixing does not soften the check.
    declare -A IS_STRICT_PATH=()
    declare -A PATH_SYMBOLS=()
    for ref_idx in "${!REFERENCE_PATHS[@]}"; do
      ref_path="${REFERENCE_PATHS[$ref_idx]}"
      ref_symbol="${REFERENCE_SYMBOLS[$ref_idx]}"
      if [[ -z "$ref_symbol" ]]; then
        IS_STRICT_PATH["$ref_path"]=1
      elif [[ -n "${PATH_SYMBOLS[$ref_path]:-}" ]]; then
        PATH_SYMBOLS["$ref_path"]="${PATH_SYMBOLS[$ref_path]}"$'\x1e'"$ref_symbol"
      else
        PATH_SYMBOLS["$ref_path"]="$ref_symbol"
      fi
    done

    # An empty pathspec would make git diff report the WHOLE tree, turning
    # "every reference was a generated artifact" into a guaranteed false
    # stale. Skip the check instead.
    if [[ "${#UNIQUE_REFERENCE_PATHS[@]}" -gt 0 ]]; then
      DIRTY_REFERENCE_PATHS=()
      STALE_REFERENCE_PATHS=()
      # Paths that would otherwise succeed (unchanged, or changed with an
      # identical symbol sequence) — re-verified clean as a batch right
      # before output (see below), since this loop checks each individually
      # and time passes between one path's check and the last one's.
      SUCCESS_CANDIDATE_PATHS=()
      declare -A WARN_SYMBOLS_FOR_PATH=()

      for ref_path in "${UNIQUE_REFERENCE_PATHS[@]}"; do
        # dirty は参照 path ごとに判定する (作業ツリー全体の dirty 状態では判断
        # しない) — index-only/working-tree-only/両方を区別せず、そのまま
        # file-level stale にする。
        if ! path_status="$(git status --porcelain -- "$ref_path" 2>/dev/null)"; then
          add_error "staleness check failed: git rejected the spec's reference paths"
          continue
        fi
        if [[ -n "$path_status" ]]; then
          DIRTY_REFERENCE_PATHS+=("$ref_path")
          continue
        fi

        if ! path_diff="$(git diff --name-only "$GROUNDED_AT".."$VALIDATION_HEAD" -- "$ref_path" 2>/dev/null)"; then
          add_error "staleness check failed: git rejected the spec's reference paths"
          continue
        fi
        if [[ -z "$path_diff" ]]; then
          SUCCESS_CANDIDATE_PATHS+=("$ref_path")
          continue
        fi

        if [[ -n "${IS_STRICT_PATH[$ref_path]:-}" ]]; then
          STALE_REFERENCE_PATHS+=("$ref_path")
          continue
        fi

        # Symbol path: conditions 2-5 (mode match, binary-free, grep-inspectable).
        # read_tree_entry distinguishes "git ran fine, no entry" (exit 1 —
        # file-level fallback, condition 2 genuinely fails) from "git itself
        # failed" (exit 2 — inspection-failed, not a mode mismatch).
        grounded_mode="$(read_tree_entry "$GROUNDED_AT" "$ref_path")"
        grounded_entry_status=$?
        if [[ "$grounded_entry_status" -eq 2 ]]; then
          add_error "staleness check failed: unable to inspect tree entry for $ref_path at grounded_at"
          continue
        elif [[ "$grounded_entry_status" -eq 1 ]]; then
          STALE_REFERENCE_PATHS+=("$ref_path")
          continue
        fi
        head_mode="$(read_tree_entry "$VALIDATION_HEAD" "$ref_path")"
        head_entry_status=$?
        if [[ "$head_entry_status" -eq 2 ]]; then
          add_error "staleness check failed: unable to inspect tree entry for $ref_path at HEAD"
          continue
        elif [[ "$head_entry_status" -eq 1 ]]; then
          STALE_REFERENCE_PATHS+=("$ref_path")
          continue
        fi
        case "$grounded_mode" in
          100644 | 100755) ;;
          *)
            STALE_REFERENCE_PATHS+=("$ref_path")
            continue
            ;;
        esac
        if [[ "$grounded_mode" != "$head_mode" ]]; then
          STALE_REFERENCE_PATHS+=("$ref_path")
          continue
        fi

        if ! read_git_blob "$GROUNDED_AT" "$ref_path" "$GROUNDED_BLOB_FILE"; then
          add_error "staleness check failed: unable to read $ref_path at grounded_at"
          continue
        fi
        if ! read_git_blob "$VALIDATION_HEAD" "$ref_path" "$HEAD_BLOB_FILE"; then
          add_error "staleness check failed: unable to read $ref_path at HEAD"
          continue
        fi

        blob_has_nul "$GROUNDED_BLOB_FILE"
        grounded_nul_status=$?
        blob_has_nul "$HEAD_BLOB_FILE"
        head_nul_status=$?
        if [[ "$grounded_nul_status" -eq 2 || "$head_nul_status" -eq 2 ]]; then
          add_error "staleness check failed: unable to inspect $ref_path for binary content"
          continue
        fi
        if [[ "$grounded_nul_status" -eq 0 || "$head_nul_status" -eq 0 ]]; then
          STALE_REFERENCE_PATHS+=("$ref_path")
          continue
        fi

        IFS=$'\x1e' read -r -a path_symbols <<<"${PATH_SYMBOLS[$ref_path]:-}"
        path_inspection_failed=0
        path_symbol_stale=0
        matched_symbols=()
        for symbol in "${path_symbols[@]}"; do
          [[ -z "$symbol" ]] && continue
          extract_matching_lines "$GROUNDED_BLOB_FILE" "$symbol" "$GROUNDED_MATCH_FILE"
          grounded_grep_status=$?
          extract_matching_lines "$HEAD_BLOB_FILE" "$symbol" "$HEAD_MATCH_FILE"
          head_grep_status=$?
          if [[ "$grounded_grep_status" -gt 1 || "$head_grep_status" -gt 1 ]]; then
            add_error "staleness check failed: symbol grep failed for $ref_path#$symbol"
            path_inspection_failed=1
            continue
          fi
          cmp -s "$GROUNDED_MATCH_FILE" "$HEAD_MATCH_FILE"
          cmp_status=$?
          case "$cmp_status" in
            0)
              matched_symbols+=("$symbol")
              ;;
            1)
              add_error "spec is stale: referenced path changed and symbol lines differ: $ref_path#$symbol"
              path_symbol_stale=1
              ;;
            *)
              # cmp exit >=2 is an I/O failure (e.g. unreadable temp file), not
              # a same/differ verdict — fail closed as inspection-failed per
              # the "git/od/cmp の実行失敗は判定不能 ERROR" contract instead of
              # silently treating it as "differs".
              add_error "staleness check failed: unable to compare matching lines for $ref_path#$symbol"
              path_inspection_failed=1
              ;;
          esac
        done
        if [[ "$path_inspection_failed" -eq 1 || "$path_symbol_stale" -eq 1 ]]; then
          continue
        fi
        SUCCESS_CANDIDATE_PATHS+=("$ref_path")
        WARN_SYMBOLS_FOR_PATH["$ref_path"]="$(
          IFS=,
          echo "${matched_symbols[*]}"
        )"
      done

      # One ERROR per path (not one aggregated line for the whole batch): each
      # path is independently identifiable, matching the per-path#symbol form
      # used for symbol-level stale above rather than mixing an aggregate list
      # form with a per-item form in the same invocation's output.
      for ref_path in "${DIRTY_REFERENCE_PATHS[@]}"; do
        add_error "spec is stale: referenced path has uncommitted changes: $ref_path"
      done
      for ref_path in "${STALE_REFERENCE_PATHS[@]}"; do
        add_error "spec is stale: referenced path changed after grounded_at: $ref_path"
      done

      # Final clean recheck: covers every path that would otherwise succeed
      # (warning candidates, unchanged symbol paths, unchanged strict
      # reuse/Test file/status-new paths) in one batch, right before output.
      # A path reported clean by its own earlier check can still have gone
      # dirty by the time the last path in this loop was checked; only a
      # recheck this close to output actually bounds that window (still not
      # to zero — see the contract note on observation limits).
      if [[ "${#ERRORS[@]}" -eq 0 && "${#SUCCESS_CANDIDATE_PATHS[@]}" -gt 0 ]]; then
        if ! FINAL_DIRTY_REFERENCES="$(git status --porcelain -- "${SUCCESS_CANDIDATE_PATHS[@]}" 2>/dev/null)"; then
          add_error "staleness check failed: git rejected the spec's reference paths"
        elif [[ -n "$FINAL_DIRTY_REFERENCES" ]]; then
          while IFS= read -r final_dirty_line; do
            [[ -z "$final_dirty_line" ]] && continue
            add_error "spec is stale: referenced path has uncommitted changes: ${final_dirty_line:3}"
          done <<<"$FINAL_DIRTY_REFERENCES"
        fi
      fi
      if [[ "${#ERRORS[@]}" -eq 0 ]]; then
        for ref_path in "${!WARN_SYMBOLS_FOR_PATH[@]}"; do
          add_warning "referenced path changed but grounded symbol lines are identical: $ref_path (symbols: ${WARN_SYMBOLS_FOR_PATH[$ref_path]})"
        done
      fi
    fi
  fi
fi

# Final HEAD recheck: unconditional whenever freshness classification ran at
# all (full validation, not --structure-only) — independent of whether this
# spec had any non-generated reference path. A spec whose references are all
# generated artifacts (or has none) must not skip this and emit READY without
# ever having checked whether HEAD moved during validation.
if [[ "${#ERRORS[@]}" -eq 0 && "$STRUCTURE_ONLY" -eq 0 && -n "$VALIDATION_HEAD" ]]; then
  recheck_validation_head_unchanged
fi

if [[ "${#ERRORS[@]}" -gt 0 ]]; then
  for error in "${ERRORS[@]}"; do
    echo "ERROR: $error" >&2
  done
  exit 1
fi

for warning in "${WARNINGS[@]}"; do
  echo "WARN: $warning" >&2
done
echo "READY: implementation-ready spec v2 ($SPEC_PATH)"
exit 0
