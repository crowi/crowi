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

# v2 provenance / umbrella の契約 (SKILL の記述と pipeline 実装のドリフト検知)
grep -Fq 'validate-implementation-spec.sh' "$PIPELINE" ||
  fail "the pipeline must run the spec validator itself on the v2 path"

grep -Fq -- '--structure-only' "$PIPELINE" ||
  fail "resume must validate structure-only (earlier phases legitimately change referenced paths)"

grep -Fq 'is an umbrella spec' "$PIPELINE" ||
  fail "umbrella specs must be refused on the v2 fast path"

SKILL="$SCRIPT_DIR/../SKILL.md"
grep -Fq 'resume: true' "$SKILL" ||
  fail "SKILL must document the resume arg for --phase re-entry"

grep -Fq 'autoContinue を明示的な boolean で必ず持たせる' "$SKILL" ||
  fail "SKILL must document that phases[].autoContinue is a required boolean"

echo "PASS: crowi-feature contract v2 review prompt"
