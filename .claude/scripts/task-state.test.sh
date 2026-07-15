#!/usr/bin/env bash
# task-state.test.sh — smoke tests for task-state.sh.
#
# Not wired into any CI/lint pipeline: .claude/ is agent tooling, not product
# code (see feature-task-state-script.md's openQuestions resolution). Run it
# manually after touching task-state.sh:
#   bash .claude/scripts/task-state.test.sh
#
# Uses TASK_STATE_STATE_DIR to point task-state.sh at a throwaway temp dir —
# never touches the real .feature-state/.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/task-state.sh"

WORK="$(mktemp -d)"
export TASK_STATE_STATE_DIR="$WORK/.feature-state"
mkdir -p "$TASK_STATE_STATE_DIR/tasks"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
section() { echo; echo "== $1 =="; }
run() { bash "$SCRIPT" "$@"; }

FIXTURE_ID="fixture-multi"
FIXTURE_FILE="$TASK_STATE_STATE_DIR/tasks/$FIXTURE_ID.json"
QUEUE_FILE="$TASK_STATE_STATE_DIR/queue.json"

cat > "$WORK/draft.json" <<'JSON'
{
  "id": "fixture-multi",
  "name": "fixture task",
  "status": "PLANNED",
  "scope": "small",
  "context": {"note": "fixture"},
  "openQuestions": [],
  "history": [{"phase": "planner", "at": "2026-01-01T00:00:00Z", "summary": "created"}],
  "phases": [
    {"id": "phase-1", "title": "Phase One", "specSectionAnchor": "### Phase 1: Phase One (即時)", "status": "PLANNED", "autoContinue": true},
    {"id": "phase-2", "title": "Phase Two (要調整)", "specSectionAnchor": "### Phase 2: Phase Two (要調整)", "status": "PLANNED", "autoContinue": false}
  ]
}
JSON

# ---------------------------------------------------------------------------
section "task create"
if run task create "$FIXTURE_ID" "$WORK/draft.json" >$WORK/ts-out.$$ 2>&1; then
  ok "create succeeds for a valid draft"
else
  fail "create should have succeeded: $(cat $WORK/ts-out.$$)"
fi
[ -f "$FIXTURE_FILE" ] && ok "task file exists after create" || fail "task file missing after create"

if run task create "$FIXTURE_ID" "$WORK/draft.json" >/dev/null 2>&1; then
  fail "create should reject an already-existing id"
else
  ok "create rejects an already-existing id"
fi

# ---------------------------------------------------------------------------
section "id validation (path traversal guard)"
# An id is used verbatim to build $TASKS_DIR/$id.json — a caller-supplied id
# containing '../' or an absolute path must never be allowed to read/write
# outside .feature-state/tasks/.
TRAVERSAL_TARGET="$TASK_STATE_STATE_DIR/escaped.json"
rm -f "$TRAVERSAL_TARGET"
if run task get "../escaped" >$WORK/ts-out.$$ 2>&1; then
  fail "task get should reject a path-traversal id (../escaped)"
else
  ok "task get rejects a path-traversal id (../escaped): $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi

if run task set-status "../escaped" IN_PROGRESS >$WORK/ts-out.$$ 2>&1; then
  fail "task set-status should reject a path-traversal id (../escaped)"
else
  ok "task set-status rejects a path-traversal id (../escaped): $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ ! -e "$TRAVERSAL_TARGET" ] && ok "no file (task JSON or lock) was created outside .feature-state/tasks via a traversal id" || fail "a file was created outside .feature-state/tasks: $TRAVERSAL_TARGET"

if run task create "/tmp/absolute-escape" "$WORK/draft.json" >$WORK/ts-out.$$ 2>&1; then
  fail "task create should reject an absolute-path id"
else
  ok "task create rejects an absolute-path id: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi

if run task set-field "$FIXTURE_ID/../escaped" name '"x"' >$WORK/ts-out.$$ 2>&1; then
  fail "task set-field should reject an id containing a slash"
else
  ok "task set-field rejects an id containing a slash: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi

# ---------------------------------------------------------------------------
section "AC (a): set-field cannot touch a protected phase field (phases[0].autoContinue)"
BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
if run task set-field "$FIXTURE_ID" autoContinue true --phase phase-1 >$WORK/ts-out.$$ 2>&1; then
  fail "set-field autoContinue should have been rejected"
else
  ok "set-field autoContinue (phase-1, = phases[0]) rejected: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
AFTER_SUM="$(jq -S . "$FIXTURE_FILE")"
[ "$BEFORE_SUM" = "$AFTER_SUM" ] && ok "file unchanged after the rejected write" || fail "file was modified despite rejection!"

# ---------------------------------------------------------------------------
section "AC (a) extended: set-field cannot touch phases[].title or phases[].specSectionAnchor either"
BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
if run task set-field "$FIXTURE_ID" title '"Hacked Title"' --phase phase-1 >$WORK/ts-out.$$ 2>&1; then
  fail "set-field title (phase-1) should have been rejected"
else
  ok "set-field title (phase-1) rejected: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
AFTER_SUM="$(jq -S . "$FIXTURE_FILE")"
[ "$BEFORE_SUM" = "$AFTER_SUM" ] && ok "file unchanged after the rejected title write" || fail "file was modified despite rejection!"

BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
if run task set-field "$FIXTURE_ID" specSectionAnchor '"### hacked"' --phase phase-1 >$WORK/ts-out.$$ 2>&1; then
  fail "set-field specSectionAnchor (phase-1) should have been rejected"
else
  ok "set-field specSectionAnchor (phase-1) rejected: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
AFTER_SUM="$(jq -S . "$FIXTURE_FILE")"
[ "$BEFORE_SUM" = "$AFTER_SUM" ] && ok "file unchanged after the rejected specSectionAnchor write" || fail "file was modified despite rejection!"

# ---------------------------------------------------------------------------
section "AC (b): phases[] cannot be added/replaced through the normal route"
if run task set-field "$FIXTURE_ID" phases \
  '[{"id":"phase-1","title":"x","specSectionAnchor":"x","autoContinue":true,"status":"PLANNED"},{"id":"phase-2","title":"y","specSectionAnchor":"y","autoContinue":false,"status":"PLANNED"},{"id":"phase-3","title":"z","specSectionAnchor":"z","autoContinue":true,"status":"PLANNED"}]' \
  >$WORK/ts-out.$$ 2>&1; then
  fail "set-field phases should have been rejected (not allowlisted)"
else
  ok "set-field phases rejected (not allowlisted): $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
PCOUNT="$(jq '.phases | length' "$FIXTURE_FILE")"
[ "$PCOUNT" = "2" ] && ok "phase count still 2 after the rejected write" || fail "phase count changed to $PCOUNT!"

# ---------------------------------------------------------------------------
section "AC (c): corrupt / empty JSON is never written"
# (i) a corrupt CURRENT file refuses ANY further write (simulates the
#     real 0-byte-truncation incident directly).
cp "$FIXTURE_FILE" "$WORK/fixture_before_corrupt.json"
printf '' > "$FIXTURE_FILE"
if run task set-status "$FIXTURE_ID" REVIEW >$WORK/ts-out.$$ 2>&1; then
  fail "set-status should refuse to operate on a corrupt (0-byte) current file"
else
  ok "set-status refuses a 0-byte current file: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ ! -s "$FIXTURE_FILE" ] && ok "0-byte file was not overwritten with something worse" || fail "corrupt file was unexpectedly modified"
cp "$WORK/fixture_before_corrupt.json" "$FIXTURE_FILE" # restore for the remaining tests

# (i-b) a MALFORMED but non-empty CURRENT file (syntactically broken JSON, not
#       just 0-byte/empty) refuses ANY further write too.
printf '{"id": "fixture-multi", "status": "PLANNED", oops not json here }}}' > "$FIXTURE_FILE"
if run task set-status "$FIXTURE_ID" REVIEW >$WORK/ts-out.$$ 2>&1; then
  fail "set-status should refuse to operate on a malformed (non-empty) current file"
else
  ok "set-status refuses a malformed non-empty current file: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
CORRUPT_SUM="$(cat "$FIXTURE_FILE")"
if run task append-history "$FIXTURE_ID" "should not apply" >$WORK/ts-out.$$ 2>&1; then
  fail "append-history should refuse to operate on a malformed (non-empty) current file"
else
  ok "append-history refuses a malformed non-empty current file: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$(cat "$FIXTURE_FILE")" = "$CORRUPT_SUM" ] && ok "malformed current file left byte-for-byte untouched (not written over)" || fail "malformed current file content changed unexpectedly"
cp "$WORK/fixture_before_corrupt.json" "$FIXTURE_FILE" # restore for the remaining tests

# (i-c) the same malformed-current-file guard via set-field (a separate code
#       path from set-status/append-history — read_current_task_content is
#       shared, but this exercises set-field's own call site).
printf '{"id": "fixture-multi", "status": "PLANNED", oops not json here }}}' > "$FIXTURE_FILE"
CORRUPT_SUM2="$(cat "$FIXTURE_FILE")"
if run task set-field "$FIXTURE_ID" description '"hacked"' >$WORK/ts-out.$$ 2>&1; then
  fail "set-field should refuse to operate on a malformed (non-empty) current file"
else
  ok "set-field refuses a malformed non-empty current file: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$(cat "$FIXTURE_FILE")" = "$CORRUPT_SUM2" ] && ok "malformed current file left byte-for-byte untouched via set-field (not written over)" || fail "malformed current file content changed unexpectedly via set-field"
cp "$WORK/fixture_before_corrupt.json" "$FIXTURE_FILE" # restore for the remaining tests

# (ii) an empty new-json file for replace-unsafe is refused, original untouched.
BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
: > "$WORK/empty.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/empty.json" --reason "test" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe should refuse an empty new-json file"
else
  ok "replace-unsafe refuses an empty new-json file: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
AFTER_SUM="$(jq -S . "$FIXTURE_FILE")"
[ "$BEFORE_SUM" = "$AFTER_SUM" ] && ok "file unchanged after the rejected replace-unsafe" || fail "file was modified despite rejected replace-unsafe!"

# (ii-b) a MALFORMED (non-empty, syntactically broken) new-json file for
#        replace-unsafe is refused too, original untouched.
BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
printf '{"id": "fixture-multi", "history": [}' > "$WORK/malformed.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/malformed.json" --reason "test" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe should refuse a malformed (non-empty) new-json file"
else
  ok "replace-unsafe refuses a malformed non-empty new-json file: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
AFTER_SUM="$(jq -S . "$FIXTURE_FILE")"
[ "$BEFORE_SUM" = "$AFTER_SUM" ] && ok "file unchanged after the rejected malformed replace-unsafe" || fail "file was modified despite rejected malformed replace-unsafe!"

# (iii) a malformed (non-empty) draft is refused by 'task create' too (a
#       separate validation path from write_atomic/commit_task_change).
printf '{"id": "fixture-malformed-create", oops }' > "$WORK/malformed-draft.json"
if run task create "fixture-malformed-create" "$WORK/malformed-draft.json" >$WORK/ts-out.$$ 2>&1; then
  fail "task create should refuse a malformed (non-empty) draft"
else
  ok "task create refuses a malformed non-empty draft: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ ! -e "$TASK_STATE_STATE_DIR/tasks/fixture-malformed-create.json" ] && ok "no task file created from a malformed draft" || fail "a task file was created despite the malformed draft!"

# ---------------------------------------------------------------------------
section "tmp+rename + .bak (every successful write)"
rm -f "$FIXTURE_FILE.bak" "$FIXTURE_FILE.tmp"
run task set-status "$FIXTURE_ID" IN_PROGRESS >/dev/null 2>&1
[ -f "$FIXTURE_FILE.bak" ] && ok ".bak created after a successful write" || fail ".bak missing after a successful write"
BAK_STATUS="$(jq -r '.status' "$FIXTURE_FILE.bak" 2>/dev/null)"
[ "$BAK_STATUS" = "PLANNED" ] && ok ".bak holds the pre-write version (status=PLANNED)" || fail ".bak has unexpected content (status=$BAK_STATUS)"
[ ! -f "$FIXTURE_FILE.tmp" ] && ok "no leftover .tmp file after a successful write" || fail ".tmp file leaked"
CUR_STATUS="$(jq -r '.status' "$FIXTURE_FILE")"
[ "$CUR_STATUS" = "IN_PROGRESS" ] && ok "current file holds the new version (status=IN_PROGRESS)" || fail "current file has unexpected status: $CUR_STATUS"

# ---------------------------------------------------------------------------
section ".bak progression across sequential writes (always the IMMEDIATELY prior version, never stale)"
BAKP_ID="fixture-bak-progression"
BAKP_FILE="$TASK_STATE_STATE_DIR/tasks/$BAKP_ID.json"
cat > "$WORK/bakp-draft.json" <<'JSON'
{"id": "fixture-bak-progression", "name": "bakp", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
run task create "$BAKP_ID" "$WORK/bakp-draft.json" >/dev/null 2>&1
rm -f "$BAKP_FILE.bak"

run task set-status "$BAKP_ID" IN_PROGRESS >/dev/null 2>&1 # PLANNED -> IN_PROGRESS; .bak should hold PLANNED
BAK1="$(jq -r '.status' "$BAKP_FILE.bak" 2>/dev/null)"
[ "$BAK1" = "PLANNED" ] && ok ".bak after write #1 holds the pre-write version (PLANNED)" || fail ".bak after write #1 is '$BAK1', expected PLANNED"

run task set-status "$BAKP_ID" REVIEW >/dev/null 2>&1 # IN_PROGRESS -> REVIEW; .bak should now hold IN_PROGRESS, NOT the stale PLANNED from write #1
BAK2="$(jq -r '.status' "$BAKP_FILE.bak" 2>/dev/null)"
[ "$BAK2" = "IN_PROGRESS" ] && ok ".bak after write #2 holds the pre-write version (IN_PROGRESS), not the stale write-#1 backup" || fail ".bak after write #2 is '$BAK2', expected IN_PROGRESS"

run task set-status "$BAKP_ID" NEEDS_WORK >/dev/null 2>&1 # REVIEW -> NEEDS_WORK; .bak should now hold REVIEW
BAK3="$(jq -r '.status' "$BAKP_FILE.bak" 2>/dev/null)"
[ "$BAK3" = "REVIEW" ] && ok ".bak after write #3 holds the pre-write version (REVIEW) — one generation only, correctly overwritten every time" || fail ".bak after write #3 is '$BAK3', expected REVIEW"
CUR3="$(jq -r '.status' "$BAKP_FILE")"
[ "$CUR3" = "NEEDS_WORK" ] && ok "current file after write #3 holds the latest version (NEEDS_WORK)" || fail "current file after write #3 is '$CUR3', expected NEEDS_WORK"

# ---------------------------------------------------------------------------
section "write_atomic aborts (no rename) when the state dir itself is unwritable"
# A readonly tasks/ dir fails at lock/tmp-creation time (an earlier stage than
# write_atomic's own cp/mv steps below) — kept as a coarse defense-in-depth
# check that ANY such failure aborts loudly and leaves the original file
# untouched, never a silent partial write. Skipped when running as root,
# where chmod-based write-denial doesn't apply.
if [ "$(id -u)" != "0" ]; then
  cat > "$WORK/ro-draft.json" <<'JSON'
{"id": "fixture-readonly-dir", "name": "ro", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
  run task create "fixture-readonly-dir" "$WORK/ro-draft.json" >/dev/null 2>&1
  RO_FILE="$TASK_STATE_STATE_DIR/tasks/fixture-readonly-dir.json"
  BEFORE_RO="$(cat "$RO_FILE")"
  chmod 555 "$TASK_STATE_STATE_DIR/tasks"
  if run task set-status "fixture-readonly-dir" IN_PROGRESS >$WORK/ts-out.$$ 2>&1; then
    fail "set-status should fail loudly (not silently) when the tasks dir is unwritable"
  else
    ok "set-status fails loudly when the tasks dir is unwritable: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
  fi
  chmod 755 "$TASK_STATE_STATE_DIR/tasks" # restore write perms so later tests + cleanup work
  AFTER_RO="$(cat "$RO_FILE")"
  [ "$BEFORE_RO" = "$AFTER_RO" ] && ok "original file byte-for-byte untouched when the write path fails" || fail "original file changed despite a failed write path!"
else
  echo "  (skip) running as root — chmod-based write-denial does not apply"
fi

# ---------------------------------------------------------------------------
section "write_atomic aborts on a fault-injected 'cp' (backup step) failure — no rename, no new .bak, .tmp discarded"
# Fault-inject cp/mv precisely via a PATH-prepended fake binary, instead of
# directory permissions (which fail one stage earlier, at lock/tmp creation,
# and never actually exercise write_atomic's own cp/mv error handling — the
# gap the previous round's reviewer finding called out).
FAULTCP_ID="fixture-fault-cp"
FAULTCP_FILE="$TASK_STATE_STATE_DIR/tasks/$FAULTCP_ID.json"
cat > "$WORK/faultcp-draft.json" <<'JSON'
{"id": "fixture-fault-cp", "name": "fault-cp", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
run task create "$FAULTCP_ID" "$WORK/faultcp-draft.json" >/dev/null 2>&1
rm -f "$FAULTCP_FILE.bak" "$FAULTCP_FILE.tmp"
BEFORE_FAULTCP="$(cat "$FAULTCP_FILE")"

FAKE_BIN_CP="$WORK/fake-bin-cp"
mkdir -p "$FAKE_BIN_CP"
cat > "$FAKE_BIN_CP/cp" <<'EOS'
#!/usr/bin/env bash
exit 1
EOS
chmod +x "$FAKE_BIN_CP/cp"

if PATH="$FAKE_BIN_CP:$PATH" run task set-status "$FAULTCP_ID" IN_PROGRESS >$WORK/ts-out.$$ 2>&1; then
  fail "set-status should fail when cp (the .bak backup step) is fault-injected to fail"
else
  ok "set-status fails when cp (the .bak backup step) fails: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$(cat "$FAULTCP_FILE")" = "$BEFORE_FAULTCP" ] && ok "original file byte-for-byte untouched when cp (backup) fails" || fail "original file changed despite a failed backup step!"
[ ! -e "$FAULTCP_FILE.bak" ] && ok "no .bak was newly created when the backup step itself failed" || fail ".bak was unexpectedly created despite the backup step failing"
[ ! -e "$FAULTCP_FILE.tmp" ] && ok ".tmp discarded (not left behind) after a fault-injected cp failure" || fail ".tmp file leaked after a fault-injected cp failure"

# ---------------------------------------------------------------------------
section "write_atomic aborts on a fault-injected 'mv' (rename step) failure — original untouched, .bak still holds the pre-write version, .tmp discarded"
FAULTMV_ID="fixture-fault-mv"
FAULTMV_FILE="$TASK_STATE_STATE_DIR/tasks/$FAULTMV_ID.json"
cat > "$WORK/faultmv-draft.json" <<'JSON'
{"id": "fixture-fault-mv", "name": "fault-mv", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
run task create "$FAULTMV_ID" "$WORK/faultmv-draft.json" >/dev/null 2>&1
rm -f "$FAULTMV_FILE.bak" "$FAULTMV_FILE.tmp"
BEFORE_FAULTMV="$(cat "$FAULTMV_FILE")"

FAKE_BIN_MV="$WORK/fake-bin-mv"
mkdir -p "$FAKE_BIN_MV"
cat > "$FAKE_BIN_MV/mv" <<'EOS'
#!/usr/bin/env bash
exit 1
EOS
chmod +x "$FAKE_BIN_MV/mv"

if PATH="$FAKE_BIN_MV:$PATH" run task set-status "$FAULTMV_ID" IN_PROGRESS >$WORK/ts-out.$$ 2>&1; then
  fail "set-status should fail when mv (the rename step) is fault-injected to fail"
else
  ok "set-status fails when mv (the rename step) fails: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$(cat "$FAULTMV_FILE")" = "$BEFORE_FAULTMV" ] && ok "original file byte-for-byte untouched when mv (rename) fails" || fail "original file changed despite a failed rename step!"
[ -e "$FAULTMV_FILE.bak" ] && ok ".bak was created (backup always runs before the rename attempt), even though the rename itself failed" || fail ".bak missing even though the backup step should have run before the failed rename"
BAKMV_STATUS="$(jq -r '.status' "$FAULTMV_FILE.bak" 2>/dev/null)"
[ "$BAKMV_STATUS" = "PLANNED" ] && ok ".bak holds the pre-write version (PLANNED) even in the mv-failure case" || fail ".bak has unexpected content ('$BAKMV_STATUS') in the mv-failure case"
[ ! -e "$FAULTMV_FILE.tmp" ] && ok ".tmp discarded (not left behind) after a fault-injected mv failure" || fail ".tmp file leaked after a fault-injected mv failure"

# ---------------------------------------------------------------------------
section "task create: TOCTOU race regression (two concurrent creates for the same id)"
# Reproduces the exact race the reviewer found: process B checks "does the
# file exist?" early (finds no), then (simulated here via the
# TASK_STATE_TEST_RACE_DELAY test seam) is preempted for a while; process A
# runs to completion (create + release lock) well within that window; B then
# resumes, acquires the now-free lock, and — WITHOUT the recheck-after-lock
# fix — would silently overwrite A's file and still report success. With the
# fix, B's authoritative existence recheck (done AFTER acquiring the lock)
# must catch A's file and refuse.
RACE_ID="fixture-race"
RACE_FILE="$TASK_STATE_STATE_DIR/tasks/$RACE_ID.json"
rm -f "$RACE_FILE"
cat > "$WORK/race-a.json" <<'JSON'
{"id": "fixture-race", "name": "race A", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
cat > "$WORK/race-b.json" <<'JSON'
{"id": "fixture-race", "name": "race B", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON

(
  TASK_STATE_TEST_RACE_DELAY=2 run task create "$RACE_ID" "$WORK/race-b.json" >"$WORK/race-b-out.$$" 2>&1
  echo $? > "$WORK/race-b-exit.$$"
) &
BPID=$!
sleep 0.3 # give B time to pass its early existence check and enter the delay
run task create "$RACE_ID" "$WORK/race-a.json" >"$WORK/race-a-out.$$" 2>&1
A_EXIT=$?
wait "$BPID"
B_EXIT="$(cat "$WORK/race-b-exit.$$")"

[ "$A_EXIT" = "0" ] && ok "race: the non-delayed create (A) succeeds" || fail "race: A should have succeeded (exit $A_EXIT): $(cat "$WORK/race-a-out.$$")"
[ "$B_EXIT" != "0" ] && ok "race: the delayed create (B) fails instead of silently overwriting A after A already won" || fail "race: B should have failed but exited 0 — TOCTOU regression! file may have been silently overwritten"
RACE_NAME="$(jq -r '.name' "$RACE_FILE" 2>/dev/null)"
[ "$RACE_NAME" = "race A" ] && ok "race: the file on disk is A's content (the winner), not silently overwritten by B" || fail "race: file content is '$RACE_NAME', expected 'race A' (B may have overwritten A after the fact)"
grep -qi "already exists" "$WORK/race-b-out.$$" && ok "race: B's failure message says 'already exists' (the post-lock recheck), confirming the TOCTOU fix fired" || fail "race: B's failure message unexpected: $(cat "$WORK/race-b-out.$$")"

# ---------------------------------------------------------------------------
section "append-history"
run task append-history "$FIXTURE_ID" "smoke test note" >/dev/null 2>&1
LAST_SUMMARY="$(jq -r '.history[-1].summary' "$FIXTURE_FILE")"
LAST_AT="$(jq -r '.history[-1].at' "$FIXTURE_FILE")"
[ "$LAST_SUMMARY" = "smoke test note" ] && [ -n "$LAST_AT" ] && [ "$LAST_AT" != "null" ] \
  && ok "append-history wraps plain text as {at, summary}" || fail "plain-text history entry missing/incorrect"

run task append-history "$FIXTURE_ID" '{"phase":"reviewer","summary":"json entry"}' >/dev/null 2>&1
LAST_PHASE="$(jq -r '.history[-1].phase' "$FIXTURE_FILE")"
LAST_AT2="$(jq -r '.history[-1].at' "$FIXTURE_FILE")"
[ "$LAST_PHASE" = "reviewer" ] && [ -n "$LAST_AT2" ] && [ "$LAST_AT2" != "null" ] \
  && ok "append-history accepts a JSON object entry and auto-injects 'at'" || fail "JSON history entry missing fields"

HIST_LEN_BEFORE="$(jq '.history | length' "$FIXTURE_FILE")"
run task append-history "$FIXTURE_ID" "another note" >/dev/null 2>&1
HIST_LEN_AFTER="$(jq '.history | length' "$FIXTURE_FILE")"
[ "$((HIST_LEN_BEFORE + 1))" = "$HIST_LEN_AFTER" ] && ok "append-history only appends (never replaces prior entries)" || fail "history length did not increase by exactly 1"

# ---------------------------------------------------------------------------
section "set-phase-status"
run task set-phase-status "$FIXTURE_ID" phase-1 REVIEW >/dev/null 2>&1
P1STATUS="$(jq -r '.phases[] | select(.id=="phase-1") | .status' "$FIXTURE_FILE")"
[ "$P1STATUS" = "REVIEW" ] && ok "set-phase-status updates the targeted phase" || fail "set-phase-status did not update phase-1"
P2STATUS="$(jq -r '.phases[] | select(.id=="phase-2") | .status' "$FIXTURE_FILE")"
[ "$P2STATUS" = "PLANNED" ] && ok "set-phase-status leaves other phases untouched" || fail "set-phase-status touched phase-2 unexpectedly"

if run task set-phase-status "$FIXTURE_ID" phase-does-not-exist REVIEW >/dev/null 2>&1; then
  fail "set-phase-status should reject an unknown phase id"
else
  ok "set-phase-status rejects an unknown phase id"
fi

if run task set-status "$FIXTURE_ID" NOT_A_REAL_STATUS >/dev/null 2>&1; then
  fail "set-status should reject an invalid status enum value"
else
  ok "set-status rejects an invalid status enum value"
fi

# ---------------------------------------------------------------------------
section "set-field (phase-scoped, allowlisted field)"
run task set-field "$FIXTURE_ID" commitPlan '[{"type":"feat","scope":"api","title":"t"}]' --phase phase-1 >/dev/null 2>&1
CP_LEN="$(jq '.phases[] | select(.id=="phase-1") | .commitPlan | length' "$FIXTURE_FILE")"
[ "$CP_LEN" = "1" ] && ok "set-field writes an allowlisted phase-scoped field" || fail "phase-scoped set-field did not apply"
P1TITLE="$(jq -r '.phases[] | select(.id=="phase-1") | .title' "$FIXTURE_FILE")"
[ "$P1TITLE" = "Phase One" ] && ok "set-field on commitPlan left the protected title untouched" || fail "title mutated unexpectedly"

VALUE_FILE_TEST="$WORK/context-value.json"
echo '{"reuseTargets": ["a", "b"]}' > "$VALUE_FILE_TEST"
run task set-field "$FIXTURE_ID" context --value-file "$VALUE_FILE_TEST" >/dev/null 2>&1
[ "$(jq -r '.context.reuseTargets[0]' "$FIXTURE_FILE")" = "a" ] && ok "set-field --value-file applies a JSON object from a file" || fail "--value-file set-field did not apply"

# ---------------------------------------------------------------------------
section "noclobber lock: a busy lock fails fast instead of blocking, and reports the holder"
LOCK_FILE="$FIXTURE_FILE.lock"
printf '{"pid":999999,"at":"2026-01-01T00:00:00Z"}\n' > "$LOCK_FILE"
BEFORE_LOCK_SUM="$(jq -S . "$FIXTURE_FILE")"
if run task set-status "$FIXTURE_ID" IN_PROGRESS >$WORK/ts-out.$$ 2>&1; then
  fail "set-status should fail fast while the lock file is held"
else
  ok "set-status fails fast when the lock is already held: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
grep -q "lock busy" "$WORK/ts-out.$$" && ok "lock-busy error message names the lock" || fail "lock-busy error message missing 'lock busy'"
grep -q '"pid":999999' "$WORK/ts-out.$$" && ok "lock-busy error message prints the holder JSON" || fail "lock-busy error message did not print the holder"
[ "$BEFORE_LOCK_SUM" = "$(jq -S . "$FIXTURE_FILE")" ] || fail "file changed despite the write failing fast on a busy lock!"
rm -f "$LOCK_FILE"
run task set-status "$FIXTURE_ID" IN_PROGRESS >/dev/null 2>&1
[ "$(jq -r '.status' "$FIXTURE_FILE")" = "IN_PROGRESS" ] && ok "write succeeds again once the stale lock is removed" || fail "write did not succeed after clearing the lock"

# ---------------------------------------------------------------------------
section "replace-unsafe (legitimate re-plan escape hatch)"
jq '.phases += [{"id":"phase-3","title":"Phase Three","specSectionAnchor":"### Phase 3","status":"PLANNED","autoContinue":true}]' "$FIXTURE_FILE" > "$WORK/replan.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/replan.json" --reason "adding phase-3 after spec revision" >$WORK/ts-out.$$ 2>&1; then
  ok "replace-unsafe accepts a phase-count change with --reason"
else
  fail "replace-unsafe should have succeeded: $(cat $WORK/ts-out.$$)"
fi
grep -qi "diff" $WORK/ts-out.$$ && ok "replace-unsafe printed a diff" || fail "replace-unsafe did not print a diff"
NEWCOUNT="$(jq '.phases | length' "$FIXTURE_FILE")"
[ "$NEWCOUNT" = "3" ] && ok "replace-unsafe applied the phase-count change" || fail "phase count is $NEWCOUNT, expected 3"
LAST_HIST_PHASE="$(jq -r '.history[-1].phase' "$FIXTURE_FILE")"
LAST_HIST_SUMMARY="$(jq -r '.history[-1].summary' "$FIXTURE_FILE")"
if [ "$LAST_HIST_PHASE" = "replace-unsafe" ] && printf '%s' "$LAST_HIST_SUMMARY" | grep -q "adding phase-3"; then
  ok "replace-unsafe auto-appended a reasoned history entry"
else
  fail "replace-unsafe history entry missing/wrong (phase=$LAST_HIST_PHASE summary=$LAST_HIST_SUMMARY)"
fi

if run task replace-unsafe "$FIXTURE_ID" "$WORK/replan.json" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe without --reason should be rejected"
else
  ok "replace-unsafe requires --reason"
fi

section "replace-unsafe still enforces invariant 5 (id unchanged)"
jq '.id = "someone-else"' "$FIXTURE_FILE" > "$WORK/badid.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/badid.json" --reason "x" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe should refuse an id change"
else
  ok "replace-unsafe refuses an id change (invariant 5 still enforced)"
fi

section "replace-unsafe still enforces invariant 2 (required top-level keys) — every required key, not just context"
# One assertion per REQUIRED_TOP_KEYS entry (id name status scope context
# openQuestions history phases): deleting any single one must be rejected,
# with the current file left byte-for-byte untouched. This directly covers
# the reviewer finding that only "context" deletion was previously tested.
for REQ_KEY in id name status scope context openQuestions history phases; do
  BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
  jq --arg k "$REQ_KEY" 'del(.[$k])' "$FIXTURE_FILE" > "$WORK/del-$REQ_KEY.json"
  if run task replace-unsafe "$FIXTURE_ID" "$WORK/del-$REQ_KEY.json" --reason "x" >$WORK/ts-out.$$ 2>&1; then
    fail "replace-unsafe should refuse deleting required top-level key '$REQ_KEY'"
  else
    ok "replace-unsafe refuses deleting required top-level key '$REQ_KEY': $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
  fi
  AFTER_SUM="$(jq -S . "$FIXTURE_FILE")"
  [ "$BEFORE_SUM" = "$AFTER_SUM" ] && ok "file unchanged after rejected deletion of '$REQ_KEY'" || fail "file changed after rejected deletion of '$REQ_KEY'!"
done

section "replace-unsafe still validates phases[]/status/history TYPES, not just key presence"
# find_missing_required_key (invariant 2, tested above) only proves a key
# exists — it says nothing about its type. A replacement like {"phases":
# "bad"} keeps every required key present yet would defeat the single-phase
# "[]" convention and every downstream phases[] consumer if let through.
BEFORE_SUM="$(jq -S . "$FIXTURE_FILE")"
jq '.phases = "not-an-array"' "$FIXTURE_FILE" > "$WORK/replan-bad-phases-type.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/replan-bad-phases-type.json" --reason "x" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe should refuse a non-array 'phases'"
else
  ok "replace-unsafe refuses a non-array 'phases': $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$BEFORE_SUM" = "$(jq -S . "$FIXTURE_FILE")" ] || fail "file changed after rejected non-array phases replacement!"

jq '.status = "NOT_A_REAL_STATUS"' "$FIXTURE_FILE" > "$WORK/replan-bad-status.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/replan-bad-status.json" --reason "x" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe should refuse an invalid status enum value"
else
  ok "replace-unsafe refuses an invalid status enum value: $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$BEFORE_SUM" = "$(jq -S . "$FIXTURE_FILE")" ] || fail "file changed after rejected invalid-status replacement!"

jq '.history = "not-an-array"' "$FIXTURE_FILE" > "$WORK/replan-bad-history.json"
if run task replace-unsafe "$FIXTURE_ID" "$WORK/replan-bad-history.json" --reason "x" >$WORK/ts-out.$$ 2>&1; then
  fail "replace-unsafe should refuse a non-array 'history'"
else
  ok "replace-unsafe refuses a non-array 'history': $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ "$BEFORE_SUM" = "$(jq -S . "$FIXTURE_FILE")" ] || fail "file changed after rejected non-array history replacement!"

section "set-field refuses to delete/null-out required top-level keys (not just replace-unsafe)"
# The replace-unsafe coverage above only proves the escape hatch enforces
# invariant 2. This proves the NORMAL route (set-field, what agents actually
# call every day) can't erase a required key either — for id/status/history/
# phases that's because they are excluded from MUTABLE_FIELDS entirely (any
# value is refused, not just a deletion-shaped one); for name/scope/context/
# openQuestions, which ARE legitimately mutable, an agent can set the value
# to null, but the key itself must still be present afterward (invariant 2 is
# "key exists", not "key is truthy") — a raw Write's full-key-removal failure
# mode stays structurally impossible either way.
SETFIELD_REQ_ID="fixture-required-key-setfield"
cat > "$WORK/req-key-draft.json" <<'JSON'
{"id": "fixture-required-key-setfield", "name": "x", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
run task create "$SETFIELD_REQ_ID" "$WORK/req-key-draft.json" >/dev/null 2>&1
SETFIELD_REQ_FILE="$TASK_STATE_STATE_DIR/tasks/$SETFIELD_REQ_ID.json"

for REQ_KEY in id status history phases; do
  if run task set-field "$SETFIELD_REQ_ID" "$REQ_KEY" null >$WORK/ts-out.$$ 2>&1; then
    fail "set-field should refuse writing protected required key '$REQ_KEY'"
  else
    ok "set-field refuses protected required key '$REQ_KEY': $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
  fi
done
for REQ_KEY in name scope context openQuestions; do
  run task set-field "$SETFIELD_REQ_ID" "$REQ_KEY" null >/dev/null 2>&1
  HAS_KEY="$(jq --arg k "$REQ_KEY" 'has($k)' "$SETFIELD_REQ_FILE")"
  [ "$HAS_KEY" = "true" ] && ok "set-field null on mutable required key '$REQ_KEY' still leaves the key present (invariant 2 key-retention)" || fail "required key '$REQ_KEY' vanished after set-field null!"
done

section "task create refuses a draft with 'phases' present but not an array"
cat > "$WORK/bad-phases-type.json" <<'JSON'
{"id": "fixture-bad-phases-type", "name": "x", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": "not-an-array"}
JSON
if run task create "fixture-bad-phases-type" "$WORK/bad-phases-type.json" >$WORK/ts-out.$$ 2>&1; then
  fail "task create should refuse a non-array 'phases'"
else
  ok "task create refuses a non-array 'phases': $(tail -1 $WORK/ts-out.$$ | cut -c1-80)"
fi
[ ! -e "$TASK_STATE_STATE_DIR/tasks/fixture-bad-phases-type.json" ] && ok "no task file created from a draft with a non-array phases" || fail "a task file was created despite the non-array phases!"

section "task create accepts an empty phases: [] (single-phase task, no per-phase breakdown)"
cat > "$WORK/empty-phases.json" <<'JSON'
{"id": "fixture-empty-phases", "name": "x", "status": "PLANNED", "scope": "small", "context": {}, "openQuestions": [], "history": [], "phases": []}
JSON
if run task create "fixture-empty-phases" "$WORK/empty-phases.json" >$WORK/ts-out.$$ 2>&1; then
  ok "task create accepts phases: []"
else
  fail "task create should accept phases: [] for a single-phase task: $(cat $WORK/ts-out.$$)"
fi

# ---------------------------------------------------------------------------
# Full pipeline dry run (AC: "実パイプラインでの通し確認"): planner -> implementer
# -> reviewer (NEEDS_WORK loop) -> reviewer (APPROVED) -> committer, entirely via
# task-state.sh, on a disposable single-phase fixture. Verifies status transitions,
# history growth, and that protected/identity fields never move.
section "full pipeline dry run (planner -> implementer -> reviewer -> committer)"
PIPE_ID="fixture-pipeline"
PIPE_FILE="$TASK_STATE_STATE_DIR/tasks/$PIPE_ID.json"
cat > "$WORK/pipe-draft.json" <<'JSON'
{
  "id": "fixture-pipeline",
  "name": "fixture pipeline dry run",
  "status": "PLANNED",
  "scope": "small",
  "context": {"reuseTargets": ["fixture"]},
  "openQuestions": [],
  "acceptanceCriteria": ["fixture AC"],
  "history": [{"phase": "planner", "at": "2026-01-01T00:00:00Z", "summary": "計画完了"}],
  "phases": []
}
JSON

# planner
run task create "$PIPE_ID" "$WORK/pipe-draft.json" >/dev/null 2>&1
IDENTITY_BEFORE="$(jq -c '{id,name,scope}' "$PIPE_FILE")"

# implementer: IN_PROGRESS -> (work) -> commitPlan filled -> REVIEW
run task set-status "$PIPE_ID" IN_PROGRESS >/dev/null 2>&1
echo '[{"type":"feat","scope":"api","title":"implement fixture"}]' > "$WORK/pipe-commitplan.json"
run task set-field "$PIPE_ID" commitPlan --value-file "$WORK/pipe-commitplan.json" >/dev/null 2>&1
run task set-status "$PIPE_ID" REVIEW >/dev/null 2>&1
run task append-history "$PIPE_ID" '{"phase":"implementer","summary":"impl done"}' >/dev/null 2>&1

# reviewer round 1: NEEDS_WORK
echo '{"decision":"NEEDS_WORK","summary":"one issue found","issues":[{"severity":"high","message":"fix x"}]}' > "$WORK/pipe-feedback-1.json"
run task set-field "$PIPE_ID" reviewFeedback --value-file "$WORK/pipe-feedback-1.json" >/dev/null 2>&1
run task set-field "$PIPE_ID" reviewAttempts 1 >/dev/null 2>&1
run task set-status "$PIPE_ID" NEEDS_WORK >/dev/null 2>&1
run task append-history "$PIPE_ID" '{"phase":"reviewer","summary":"NEEDS_WORK: one issue found"}' >/dev/null 2>&1

# implementer re-work -> REVIEW again
run task set-status "$PIPE_ID" IN_PROGRESS >/dev/null 2>&1
run task append-history "$PIPE_ID" '{"phase":"implementer (re-work)","summary":"fixed x"}' >/dev/null 2>&1
run task set-status "$PIPE_ID" REVIEW >/dev/null 2>&1

# reviewer round 2: APPROVED
echo '{"decision":"APPROVED","summary":"all good"}' > "$WORK/pipe-feedback-2.json"
run task set-field "$PIPE_ID" reviewFeedback --value-file "$WORK/pipe-feedback-2.json" >/dev/null 2>&1
run task set-field "$PIPE_ID" reviewAttempts 2 >/dev/null 2>&1
run task set-status "$PIPE_ID" APPROVED >/dev/null 2>&1
run task append-history "$PIPE_ID" '{"phase":"reviewer","summary":"APPROVED"}' >/dev/null 2>&1

# committer: COMMITTED
echo '{"branch":"main","commits":["abc1234"],"committedAt":"2026-01-02T00:00:00Z"}' > "$WORK/pipe-commitinfo.json"
run task set-field "$PIPE_ID" commitInfo --value-file "$WORK/pipe-commitinfo.json" >/dev/null 2>&1
run task set-status "$PIPE_ID" COMMITTED >/dev/null 2>&1
run task append-history "$PIPE_ID" '{"phase":"committer","summary":"main に 1 commit"}' >/dev/null 2>&1

FINAL_STATUS="$(jq -r '.status' "$PIPE_FILE")"
[ "$FINAL_STATUS" = "COMMITTED" ] && ok "pipeline dry run reaches COMMITTED via task-state.sh only" || fail "final status is $FINAL_STATUS, expected COMMITTED"

HIST_LEN="$(jq '.history | length' "$PIPE_FILE")"
# 1 (planner, from the draft) + 5 appends (implementer, reviewer x2, re-work, committer)
[ "$HIST_LEN" = "6" ] && ok "history grew by exactly one append per phase transition (6 entries)" || fail "history has $HIST_LEN entries, expected 6"

IDENTITY_AFTER="$(jq -c '{id,name,scope}' "$PIPE_FILE")"
[ "$IDENTITY_BEFORE" = "$IDENTITY_AFTER" ] && ok "id/name/scope unchanged across the whole planner->...->committer cycle" || fail "identity fields drifted: $IDENTITY_BEFORE -> $IDENTITY_AFTER"

[ "$(jq -r '.commitInfo.branch' "$PIPE_FILE")" = "main" ] && ok "commitInfo recorded by the committer step" || fail "commitInfo missing/wrong"
[ "$(jq -r '.reviewFeedback.decision' "$PIPE_FILE")" = "APPROVED" ] && ok "reviewFeedback reflects the final (APPROVED) review round" || fail "reviewFeedback not the final round"

# integrate-worktree: COMMITTED -> INTEGRATED (merged into main). AC:
# "実パイプラインでの通し確認" names this full chain including the final
# integrate step, not just up to COMMITTED.
run task set-status "$PIPE_ID" INTEGRATED >/dev/null 2>&1
run task append-history "$PIPE_ID" '{"phase":"integrate","summary":"merged into main"}' >/dev/null 2>&1

FINAL_STATUS="$(jq -r '.status' "$PIPE_FILE")"
[ "$FINAL_STATUS" = "INTEGRATED" ] && ok "pipeline dry run reaches INTEGRATED via task-state.sh only" || fail "final status is $FINAL_STATUS, expected INTEGRATED"

HIST_LEN="$(jq '.history | length' "$PIPE_FILE")"
[ "$HIST_LEN" = "7" ] && ok "history grew by exactly one more append for the integrate step (7 entries)" || fail "history has $HIST_LEN entries, expected 7"

IDENTITY_AFTER_INTEGRATE="$(jq -c '{id,name,scope}' "$PIPE_FILE")"
[ "$IDENTITY_BEFORE" = "$IDENTITY_AFTER_INTEGRATE" ] && ok "id/name/scope still unchanged after the integrate step" || fail "identity fields drifted after integrate: $IDENTITY_BEFORE -> $IDENTITY_AFTER_INTEGRATE"

PHASES_AFTER_INTEGRATE="$(jq -c '.phases' "$PIPE_FILE")"
[ "$PHASES_AFTER_INTEGRATE" = "[]" ] && ok "phases[] still [] (protected) after the integrate step" || fail "phases[] changed after integrate: $PHASES_AFTER_INTEGRATE"

# ---------------------------------------------------------------------------
section "queue set-current / get"
run queue set-current "$FIXTURE_ID" >/dev/null 2>&1
[ "$(jq -r '.currentTask' "$QUEUE_FILE")" = "$FIXTURE_ID" ] && ok "queue set-current sets currentTask" || fail "queue currentTask not set"
run queue set-current null >/dev/null 2>&1
[ "$(jq -r '.currentTask' "$QUEUE_FILE")" = "null" ] && ok "queue set-current null clears currentTask" || fail "queue currentTask not cleared"
run queue get >$WORK/ts-out.$$ 2>&1 && ok "queue get prints the current queue.json" || fail "queue get failed"

# ---------------------------------------------------------------------------
section "PreToolUse hook (validate-task-state-write.js): blocks state paths, allows everything else"
HOOK="$HERE/validate-task-state-write.js"
if command -v node >/dev/null 2>&1; then
  ALLOWED_INPUT='{"tool_name":"Write","tool_input":{"file_path":"packages/api/src/index.ts","content":"x"}}'
  if printf '%s' "$ALLOWED_INPUT" | node "$HOOK" >/dev/null 2>&1; then
    ok "hook allows Write to a non-state path (packages/api/src/index.ts)"
  else
    fail "hook should not block Write to a non-state path"
  fi

  # NOTE: the hook script itself only inspects tool_input.file_path — it does
  # NOT branch on tool_name. Read is unaffected in practice because the
  # settings.json PreToolUse registration matches "Write|Edit" only, so the
  # harness never invokes this hook for a Read call in the first place; that
  # matcher-level gating (not this script) is what makes Read "unaffected".

  BLOCKED_INPUT='{"tool_name":"Write","tool_input":{"file_path":".feature-state/tasks/fixture-multi.json","content":"x"}}'
  if printf '%s' "$BLOCKED_INPUT" | node "$HOOK" >/dev/null 2>&1; then
    fail "hook should block Write to .feature-state/tasks/*.json"
  else
    ok "hook blocks Write to .feature-state/tasks/*.json"
  fi

  BLOCKED_QUEUE_INPUT='{"tool_name":"Edit","tool_input":{"file_path":".feature-state/queue.json"}}'
  if printf '%s' "$BLOCKED_QUEUE_INPUT" | node "$HOOK" >/dev/null 2>&1; then
    fail "hook should block Edit to .feature-state/queue.json"
  else
    ok "hook blocks Edit to .feature-state/queue.json"
  fi

  # Regression: a path containing ".." must be normalized BEFORE the regex
  # test, not matched as a raw string — ".feature-state/tasks/../queue.json"
  # resolves at the filesystem level to the protected queue.json, so the raw
  # string (which matches neither TASKS_RE nor QUEUE_RE literally) must not
  # be allowed through.
  TRAVERSAL_QUEUE_INPUT='{"tool_name":"Write","tool_input":{"file_path":".feature-state/tasks/../queue.json","content":"x"}}'
  if printf '%s' "$TRAVERSAL_QUEUE_INPUT" | node "$HOOK" >/dev/null 2>&1; then
    fail "hook should block a '..'-traversal path that resolves to queue.json"
  else
    ok "hook blocks '..'-traversal path resolving to queue.json"
  fi

  TRAVERSAL_TASKS_INPUT='{"tool_name":"Write","tool_input":{"file_path":".feature-state/tasks/sub/../fixture-multi.json","content":"x"}}'
  if printf '%s' "$TRAVERSAL_TASKS_INPUT" | node "$HOOK" >/dev/null 2>&1; then
    fail "hook should block a '..'-traversal path that resolves to a tasks/*.json file"
  else
    ok "hook blocks '..'-traversal path resolving to tasks/*.json"
  fi
else
  echo "  (skip) node not found on PATH — cannot exercise the PreToolUse hook directly"
fi

# ---------------------------------------------------------------------------
section "--help"
if run --help | grep -qi "task-state.sh"; then
  ok "--help prints usage"
else
  fail "--help did not print usage"
fi
if run --help | grep -qi "\.bak"; then
  ok "--help documents the .bak recovery procedure"
else
  fail "--help missing .bak recovery documentation"
fi
if run --help | grep -qi "replace-unsafe"; then
  ok "--help documents replace-unsafe"
else
  fail "--help missing replace-unsafe documentation"
fi

# ---------------------------------------------------------------------------
echo
echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
