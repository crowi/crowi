#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE="$SCRIPT_DIR/../pipeline.workflow.js"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -Fq 'For contract v2, derive docs and e2e obligations from the spec itself' "$PIPELINE" ||
  fail "Codex review runner must derive v2 docs/e2e obligations from the spec"

grep -Fq 'Missing any docs or e2e work explicitly required by a contract v2 spec is blocking' "$PIPELINE" ||
  fail "explicit v2 docs/e2e omissions must be blocking"

grep -Fq 'For contract v2, independently derive docs/e2e obligations from the spec itself' "$PIPELINE" ||
  fail "Claude fallback reviewer must apply the same v2 docs/e2e contract"

echo "PASS: crowi-feature contract v2 review prompt"
