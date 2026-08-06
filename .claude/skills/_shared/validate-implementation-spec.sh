#!/usr/bin/env bash

set -u

usage() {
  echo "usage: validate-implementation-spec.sh <spec-path>" >&2
  exit 2
}

[[ "$#" -eq 1 ]] || usage

SPEC_PATH="$1"
if [[ ! -f "$SPEC_PATH" ]]; then
  echo "ERROR: spec not found: $SPEC_PATH" >&2
  exit 1
fi

ERRORS=()

add_error() {
  ERRORS+=("$1")
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
      if ! phase_errors="$(bash "$VALIDATOR" "$phase_path" 2>&1 >/dev/null)"; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && add_error "phase $phase: ${line#ERROR: }"
        done <<<"$phase_errors"
      else
        VALIDATED_PHASES=$((VALIDATED_PHASES + 1))
      fi
    done
  fi

  if [[ "${#ERRORS[@]}" -gt 0 ]]; then
    for error in "${ERRORS[@]}"; do
      echo "ERROR: $error" >&2
    done
    exit 1
  fi
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
  REFERENCE_PATHS+=("$path")

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
      done < <(
        awk -F'`' '{ for (i = 2; i <= NF; i += 2) print $i }' <<<"$symbols"
      )
    fi
  elif [[ "$status" == "new" && -e "$path" ]]; then
    add_error "implementation map marks an existing path as new: $path"
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
    REFERENCE_PATHS+=("$reuse_path")
    if [[ ! -f "$reuse_path" ]]; then
      add_error "reuse path does not exist: $reuse_path"
    elif [[ -n "$reuse_symbol" ]] && ! grep -Fq -- "$reuse_symbol" "$reuse_path"; then
      add_error "reuse symbol is not grounded in $reuse_path: $reuse_symbol"
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
      REFERENCE_PATHS+=("$test_file")
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
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    add_error "freshness check requires a git worktree"
  elif ! git cat-file -e "${GROUNDED_AT}^{commit}" >/dev/null 2>&1; then
    add_error "grounded_at commit does not exist: $GROUNDED_AT"
  elif ! git merge-base --is-ancestor "$GROUNDED_AT" HEAD >/dev/null 2>&1; then
    add_error "spec is stale: grounded_at is not an ancestor of HEAD"
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
    # An empty pathspec would make git diff report the WHOLE tree, turning
    # "every reference was a generated artifact" into a guaranteed false
    # stale. Skip the check instead.
    if [[ "${#UNIQUE_REFERENCE_PATHS[@]}" -gt 0 ]]; then
      # git's exit status must be checked, not just its output: a pathspec it
      # rejects makes it fail with empty stdout, which is indistinguishable
      # from "nothing changed" and would pass the spec without checking it.
      if ! CHANGED_REFERENCES="$(git diff --name-only "$GROUNDED_AT"..HEAD -- "${UNIQUE_REFERENCE_PATHS[@]}" 2>/dev/null)"; then
        add_error "staleness check failed: git rejected the spec's reference paths"
      elif [[ -n "$CHANGED_REFERENCES" ]]; then
        add_error "spec is stale: referenced paths changed after grounded_at: $(echo "$CHANGED_REFERENCES" | tr '\n' ' ')"
      fi
      if ! DIRTY_REFERENCES="$(git status --porcelain -- "${UNIQUE_REFERENCE_PATHS[@]}" 2>/dev/null)"; then
        add_error "staleness check failed: git rejected the spec's reference paths"
      elif [[ -n "$DIRTY_REFERENCES" ]]; then
        add_error "spec is stale: referenced paths have uncommitted changes"
      fi
    fi
  fi
fi

if [[ "${#ERRORS[@]}" -gt 0 ]]; then
  for error in "${ERRORS[@]}"; do
    echo "ERROR: $error" >&2
  done
  exit 1
fi

echo "READY: implementation-ready spec v2 ($SPEC_PATH)"
