#!/usr/bin/env bash
# codex-run.sh — the single entry point for every `codex exec` call made from
# crowi skills (crowi-design / crowi-review / crowi-feature / orchestrate C).
# Called by thin glue agents (haiku/low) from Workflow scripts, or directly
# from a skill's Bash step.
#
# Usage (exec mode — the normal path; structured output):
#   codex-run.sh --prompt-file <path> --out <path>
#                [--schema-file <path>]   # NOTE: OpenAI strict mode — every object
#                                         # in the schema MUST set
#                                         # "additionalProperties": false and list
#                                         # every property in "required" (optional
#                                         # fields use anyOf [T, null]),
#                                         # or codex rejects it with a 400.
#                [--sandbox read-only|workspace-write]   # default: read-only
#                [--tier sol|terra|luna]                 # semantic model tier:
#                                         # sol=hardest (gpt-5.6-sol, effort high)
#                                         # terra=general (gpt-5.6-terra, medium)
#                                         # luna=simple (gpt-5.6-luna, low).
#                                         # Model ids live only here; callers pass
#                                         # the tier. Omit → codex config default.
#                [--model <m>] [--effort <e>]            # override tier defaults
#                [--label <s>]                           # log prefix only
#
# Usage (review mode — codex's stock reviewer; free-form text output):
#   codex-run.sh --mode review --review-target "--uncommitted"|"--base <b>"|"--commit <sha>"
#                --out <path> [--model/--effort/--label]
#   Measured on codex-cli 0.142.5: `codex exec review` REJECTS a custom PROMPT
#   when a target flag is given, and silently IGNORES --output-schema (the
#   final message stays free-form). So review mode takes NO --prompt-file and
#   NO --schema-file — any reviewer that needs custom instructions (embedded
#   AC, adversarial framing) or structured findings must use exec mode with a
#   read-only sandbox and ask codex to run `git diff`/`git status` itself.
#
# Exit code contract (the glue agent branches on this):
#   0 — success; <out> holds the result (valid JSON when --schema-file given)
#   2 — codex unavailable (not installed / auth / quota / rate-limit — fall back to Claude)
#   3 — codex ran but the output is invalid (empty out / invalid JSON), or bad usage
#
# stderr of codex is always appended to <out>.stderr, stdout to <out>.log,
# so a failed run can be debugged after the fact.
#
# No built-in timeout (macOS has no GNU timeout): the caller's Bash timeout
# (600000ms) bounds the run; the glue treats a Bash-level kill as codex_unavailable.
#
# Test hook: CODEX_RUN_FORCE_UNAVAILABLE=1 exits 2 immediately (E2E check of
# the Claude-fallback path without uninstalling codex).
set -u

PROMPT_FILE="" OUT="" SCHEMA_FILE="" SANDBOX="read-only" MODE="exec"
REVIEW_TARGET="" MODEL="" EFFORT="" TIER="" LABEL="codex-run"

while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file)   PROMPT_FILE="$2"; shift 2 ;;
    --out)           OUT="$2"; shift 2 ;;
    --schema-file)   SCHEMA_FILE="$2"; shift 2 ;;
    --sandbox)       SANDBOX="$2"; shift 2 ;;
    --mode)          MODE="$2"; shift 2 ;;
    --review-target) REVIEW_TARGET="$2"; shift 2 ;;
    --model)         MODEL="$2"; shift 2 ;;
    --effort)        EFFORT="$2"; shift 2 ;;
    --tier)          TIER="$2"; shift 2 ;;
    --label)         LABEL="$2"; shift 2 ;;
    *) echo "[$LABEL] unknown option: $1" >&2; exit 3 ;;
  esac
done

# ---- tier → (model, effort) --------------------------------------------
# Callers pass a SEMANTIC tier (sol=hardest / terra=general / luna=simple)
# instead of hard-coding a model id, so the actual model names live in ONE
# place — swap them here when a new codex generation ships. Each tier also
# carries a default reasoning effort (sol runs hard, luna runs cheap).
# Explicit --model / --effort still win over the tier defaults (escape hatch),
# and passing no --tier keeps the legacy behavior (codex config default).
if [ -n "$TIER" ]; then
  case "$TIER" in
    sol)   TIER_MODEL="gpt-5.6-sol";   TIER_EFFORT="high" ;;
    terra) TIER_MODEL="gpt-5.6-terra"; TIER_EFFORT="medium" ;;
    luna)  TIER_MODEL="gpt-5.6-luna";  TIER_EFFORT="low" ;;
    *) echo "[$LABEL] invalid --tier: $TIER (want sol|terra|luna)" >&2; exit 3 ;;
  esac
  [ -z "$MODEL" ] && MODEL="$TIER_MODEL"
  [ -z "$EFFORT" ] && EFFORT="$TIER_EFFORT"
fi

case "$MODE" in exec|review) ;; *) echo "[$LABEL] invalid --mode: $MODE" >&2; exit 3 ;; esac
case "$SANDBOX" in read-only|workspace-write) ;; *) echo "[$LABEL] invalid --sandbox: $SANDBOX" >&2; exit 3 ;; esac
if [ -z "$OUT" ]; then
  echo "[$LABEL] --out is required" >&2
  exit 3
fi
if [ "$MODE" = "exec" ]; then
  if [ -z "$PROMPT_FILE" ]; then
    echo "[$LABEL] --prompt-file is required in exec mode" >&2
    exit 3
  fi
  if [ ! -s "$PROMPT_FILE" ]; then
    echo "[$LABEL] prompt file missing or empty: $PROMPT_FILE" >&2
    exit 3
  fi
else
  # review mode: codex-cli rejects PROMPT alongside a target flag and ignores
  # --output-schema (measured 0.142.5) — refuse both so callers don't silently
  # lose their instructions/schema. Use exec mode instead when you need them.
  if [ -z "$REVIEW_TARGET" ]; then
    echo "[$LABEL] --review-target is required in review mode" >&2
    exit 3
  fi
  if [ -n "$PROMPT_FILE" ] || [ -n "$SCHEMA_FILE" ]; then
    echo "[$LABEL] review mode takes no --prompt-file/--schema-file (codex rejects/ignores them); use --mode exec" >&2
    exit 3
  fi
fi

# ---- preflight -------------------------------------------------------------
if [ "${CODEX_RUN_FORCE_UNAVAILABLE:-0}" = "1" ]; then
  echo "[$LABEL] forced unavailable (CODEX_RUN_FORCE_UNAVAILABLE=1)" >&2
  exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "[$LABEL] codex CLI not found on PATH" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT")"
STDERR_FILE="$OUT.stderr"
LOG_FILE="$OUT.log"
: > "$STDERR_FILE"
: > "$LOG_FILE"

# ---- command assembly ------------------------------------------------------
# review mode: `codex exec review` is sandboxed by codex itself (no -s flag),
# takes no PROMPT with a target flag, and ignores --output-schema (see header) —
# the preflight above already rejected --prompt-file/--schema-file for it.
build_cmd() {
  CMD=(codex exec)
  if [ "$MODE" = "review" ]; then
    CMD+=(review)
    # intentionally word-split: the target is a flag group like "--base main"
    # shellcheck disable=SC2206
    CMD+=($REVIEW_TARGET)
  else
    CMD+=(-s "$SANDBOX")
  fi
  [ -n "$MODEL" ] && CMD+=(-m "$MODEL")
  [ -n "$EFFORT" ] && CMD+=(-c "model_reasoning_effort=\"$EFFORT\"")
  [ -n "$SCHEMA_FILE" ] && CMD+=(--output-schema "$SCHEMA_FILE")
  CMD+=(-o "$OUT")
  if [ "$MODE" = "exec" ]; then CMD+=(-); fi
}

# Patterns that mean "codex itself is unavailable" (quota / auth / rate-limit),
# not "codex produced a bad answer". Measured against real codex-cli stderr;
# extend as new failure shapes are observed (spec §15 OQ-2). Unclassifiable
# failures fall through to exit 3 — the glue falls back to Claude either way.
# MCP-server connection noise (rmcp::transport lines carrying a third-party
# server's "invalid_token") is excluded first — it appears on every run and
# says nothing about codex's own auth/quota state (measured 2026-07-02).
UNAVAILABLE_RE='quota|rate.?limit|429|too many requests|usage_limit|usage limit|401|unauthorized|not logged in|login required|codex login|billing'

is_unavailable() {
  grep -hviE 'rmcp::transport' "$STDERR_FILE" "$LOG_FILE" 2>/dev/null | grep -qiE "$UNAVAILABLE_RE"
}

json_valid() {
  if command -v jq >/dev/null 2>&1; then
    jq -e . "$OUT" >/dev/null 2>&1
  elif command -v node >/dev/null 2>&1; then
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$OUT" >/dev/null 2>&1
  else
    return 0 # no validator available — accept non-empty output as-is
  fi
}

run_once() {
  local attempt=$1
  # Truncate the output BEFORE every attempt, including the first. `succeeded`
  # only checks that `$OUT` is non-empty and parses, so a file left behind by a
  # PREVIOUS invocation is indistinguishable from a fresh result whenever codex
  # exits 0 without writing one — the caller then reads a stale verdict and
  # reports it as this run's. Callers key `--out` on a stable path (the design
  # workflow uses `.reviews/codex-runs/<slug>/<lens>/out.json`), so that
  # leftover is the normal case, not an exotic one.
  : > "$OUT"
  {
    echo "--- [$LABEL] attempt $attempt: $(printf '%q ' "${CMD[@]}")"
  } >> "$STDERR_FILE"
  if [ "$MODE" = "exec" ]; then
    "${CMD[@]}" < "$PROMPT_FILE" >> "$LOG_FILE" 2>> "$STDERR_FILE"
  else
    "${CMD[@]}" < /dev/null >> "$LOG_FILE" 2>> "$STDERR_FILE"
  fi
}

succeeded() {
  [ "$RC" -eq 0 ] && [ -s "$OUT" ] || return 1
  if [ -n "$SCHEMA_FILE" ]; then json_valid; fi
}

# ---- run (with a single retry) ---------------------------------------------
build_cmd
run_once 1
RC=$?
if ! succeeded; then
  if is_unavailable; then
    echo "[$LABEL] codex unavailable (quota/auth/rate-limit) — no retry" >&2
    exit 2
  fi
  echo "[$LABEL] attempt 1 failed (exit=$RC), retrying once" >&2
  run_once 2
  RC=$?
fi

if succeeded; then
  exit 0
fi
if is_unavailable; then
  echo "[$LABEL] codex unavailable (quota/auth/rate-limit)" >&2
  exit 2
fi
echo "[$LABEL] codex ran but output is invalid (exit=$RC, out=$([ -s "$OUT" ] && echo 'non-empty/invalid-json' || echo 'empty')) — see $STDERR_FILE" >&2
exit 3
