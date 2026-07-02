#!/usr/bin/env bash
# codex-run.sh — the single entry point for every `codex exec` call made from
# crowi skills (crowi-design / crowi-review / crowi-feature / orchestrate C).
# Called by thin glue agents (haiku/low) from Workflow scripts, or directly
# from a skill's Bash step.
#
# Usage:
#   codex-run.sh --prompt-file <path> --out <path>
#                [--schema-file <path>]   # NOTE: OpenAI strict mode — every object
#                                         # in the schema MUST set
#                                         # "additionalProperties": false and list
#                                         # every property in "required" (optional
#                                         # fields use type: ["...","null"]),
#                                         # or codex rejects it with a 400.
#                [--sandbox read-only|workspace-write]   # default: read-only (exec mode only)
#                [--mode exec|review]                    # default: exec
#                [--review-target "--uncommitted" | "--base main" | "--commit <sha>"]
#                [--model <m>] [--effort <e>]            # default: codex config
#                [--label <s>]                           # log prefix only
#
# Exit code contract (the glue agent branches on this):
#   0 — success; <out> holds the result (valid JSON when --schema-file given)
#   2 — codex unavailable (not installed / auth / quota / rate-limit — fall back to Claude)
#   3 — codex ran but the output is invalid (empty out / invalid JSON)
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
REVIEW_TARGET="" MODEL="" EFFORT="" LABEL="codex-run"

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
    --label)         LABEL="$2"; shift 2 ;;
    *) echo "[$LABEL] unknown option: $1" >&2; exit 3 ;;
  esac
done

if [ -z "$PROMPT_FILE" ] || [ -z "$OUT" ]; then
  echo "[$LABEL] --prompt-file and --out are required" >&2
  exit 3
fi
if [ ! -s "$PROMPT_FILE" ]; then
  echo "[$LABEL] prompt file missing or empty: $PROMPT_FILE" >&2
  exit 3
fi
case "$MODE" in exec|review) ;; *) echo "[$LABEL] invalid --mode: $MODE" >&2; exit 3 ;; esac
case "$SANDBOX" in read-only|workspace-write) ;; *) echo "[$LABEL] invalid --sandbox: $SANDBOX" >&2; exit 3 ;; esac

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
# review mode: `codex exec review` is sandboxed by codex itself (no -s flag);
# it DOES accept --output-schema / -o (verified on codex-cli 0.142.5).
build_cmd() {
  CMD=(codex exec)
  if [ "$MODE" = "review" ]; then
    CMD+=(review)
    if [ -n "$REVIEW_TARGET" ]; then
      # intentionally word-split: the target is a flag group like "--base main"
      # shellcheck disable=SC2206
      CMD+=($REVIEW_TARGET)
    fi
  else
    CMD+=(-s "$SANDBOX")
  fi
  [ -n "$MODEL" ] && CMD+=(-m "$MODEL")
  [ -n "$EFFORT" ] && CMD+=(-c "model_reasoning_effort=\"$EFFORT\"")
  [ -n "$SCHEMA_FILE" ] && CMD+=(--output-schema "$SCHEMA_FILE")
  CMD+=(-o "$OUT" -)
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
  {
    echo "--- [$LABEL] attempt $attempt: $(printf '%q ' "${CMD[@]}")"
  } >> "$STDERR_FILE"
  "${CMD[@]}" < "$PROMPT_FILE" >> "$LOG_FILE" 2>> "$STDERR_FILE"
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
  : > "$OUT"
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
