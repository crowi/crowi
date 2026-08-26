#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/../validate-implementation-spec.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$actual" -ne "$expected" ]]; then
    fail "$message (expected status $expected, got $actual)"
  fi
}

run_validator() {
  local repo="$1"
  local spec="$2"
  local output_file="$3"
  local status

  set +e
  (
    cd "$repo"
    "$VALIDATOR" "$spec"
  ) >"$output_file" 2>&1
  status=$?
  set -e
  printf '%s' "$status"
}

# run_validator_with_path: like run_validator but prepends a shim directory
# to PATH so a fake git/grep can intercept specific invocations. The shim
# itself reads its real-binary target and any scenario state from inherited
# environment variables (exported by the caller before invoking this) rather
# than from baked-in paths, so the shim script content never has to be
# regenerated per repo/target.
run_validator_with_path() {
  local repo="$1"
  local spec="$2"
  local output_file="$3"
  local shim_dir="$4"
  local status

  set +e
  (
    cd "$repo"
    PATH="$shim_dir:$PATH" "$VALIDATOR" "$spec"
  ) >"$output_file" 2>&1
  status=$?
  set -e
  printf '%s' "$status"
}

REAL_GIT_BIN="$(command -v git)"
REAL_GREP_BIN="$(command -v grep)"
export REAL_GIT_BIN REAL_GREP_BIN

# write_chain_fixture <file> <chain-count>: a client.ts#CrowiApiClient-shaped
# fixture — an intersection type built from N named chains, where the
# literal symbol only appears in the doc comment, the type declaration's
# first line, and the createClient signature/cast — never in the
# continuation lines that a new chain member touches, so adding a chain
# edits only lines that never contained the symbol.
write_chain_fixture() {
  local file="$1" count="$2" i
  {
    for ((i = 1; i <= count; i++)); do
      printf 'export const chain%d = createRoute();\n' "$i"
    done
    printf '\n'
    printf '/**\n * CrowiApiClient composes every route chain into one intersection type.\n */\n'
    printf 'export type CrowiApiClient = typeof chain1'
    for ((i = 2; i <= count; i++)); do
      printf ' &\n  typeof chain%d' "$i"
    done
    printf ';\n\n'
    printf 'export const createClient = (): CrowiApiClient => {\n  return {} as CrowiApiClient;\n};\n'
  } >"$file"
}

# write_messages_fixture <file> <extra-key-count>: a
# messages/ja.json#admin.plugins-shaped fixture — flat dotted-key lines, a
# handful under the admin.plugins.* namespace plus N extra keys inserted
# between two already-comma-terminated lines, so a pure addition never
# touches the admin.plugins.* lines' content or order.
write_messages_fixture() {
  local file="$1" extra="$2" i
  {
    printf '{\n'
    printf '  "admin.nav_plugins": "プラグイン管理",\n'
    # Extra keys are inserted here, between two lines that already end in a
    # comma, so a pure addition never rewrites an existing line's bytes (not
    # even to add/drop a trailing comma) — unlike appending after the last
    # key, which would need to add a comma to a line that had none.
    for ((i = 1; i <= extra; i++)); do
      printf '  "admin.oauth_session.key_%d": "value %d",\n' "$i" "$i"
    done
    printf '  "admin.plugins.action_close": "閉じる",\n'
    printf '  "admin.plugins.action_copy": "コピー",\n'
    printf '  "admin.plugins.back_to_list": "プラグイン一覧に戻る",\n'
    printf '  "admin.storage.title": "ストレージ"\n'
    printf '}\n'
  } >"$file"
}

write_ready_spec() {
  local path="$1"
  local grounded_at="$2"
  local change_path="$3"
  local change_symbol="${4:-exportRows}"

  cat >"$path" <<EOF
---
id: feature-fast-export
name: 高速エクスポート
scope: medium
spec_contract: 2
status: approved
implementation_ready: true
grounded_at: $grounded_at
---

## 背景 / why

既存のエクスポート処理を高速化する。

## やること (ユーザー視点)

大量データをタイムアウトせずエクスポートできる。

## やらないこと (out of scope)

- 新しいファイル形式の追加

## 設計の主な判断

- 既存のストリーミング境界を維持する。

## 実装マップ (implementation map)

### Change: \`$change_path\`

- status: existing
- symbols: \`$change_symbol\`
- changes: バッチ取得をストリームへ順次渡す。
- reuse: \`src/export/cursor.ts#iterateCursor\`

## 処理・データフロー (control / data flow)

1. handler が認可を確認する。
2. cursor でデータを取得する。
3. serializer が出力へ順次書き込む。

## 契約・不変条件 (contracts / invariants)

- Public API/types: 既存の export API と返却型を維持する。
- Authentication/authorization: 既存の export 権限チェックを維持する。
- Validation: 既存の export filter validation を維持する。
- Error semantics: 書き込み失敗は既存の export error に変換する。
- Transaction/concurrency: read transaction をバッチ間で共有しない。
- Backward compatibility/migration: migration は不要。既存 API と互換にする。
- Performance/resource limit: 1 バッチ 1000 件以下で処理する。

## 受け入れ基準 (acceptance criteria)

- [ ] AC-1: 10万件をストリーミングで出力できる。

## テスト計画 (test plan)

| AC | Test file | Case | Level |
|---|---|---|---|
| AC-1 | \`src/export/export.test.ts\` | 10万件を複数バッチで出力する | integration |

## 実装順序 (implementation order)

1. cursor 利用へ切り替える。
2. integration test を追加する。

## 未確定事項 (open questions)

- なし
EOF
}

[[ -x "$VALIDATOR" ]] || fail "validator is missing or not executable: $VALIDATOR"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO="$TMP_ROOT/repo"
mkdir -p "$REPO/src/export" "$REPO/specs"
git -C "$REPO" init -q
git -C "$REPO" config user.email "spec-test@example.com"
git -C "$REPO" config user.name "Spec Test"
git -C "$REPO" config commit.gpgsign false
printf 'export function exportRows() {}\n' >"$REPO/src/export/export.ts"
printf 'export function iterateCursor() {}\n' >"$REPO/src/export/cursor.ts"
printf 'test("exports rows", () => {})\n' >"$REPO/src/export/export.test.ts"
git -C "$REPO" add src/export/export.ts src/export/cursor.ts src/export/export.test.ts
git -C "$REPO" commit -qm "initial"
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"

LEGACY_SPEC="$REPO/specs/legacy.md"
cat >"$LEGACY_SPEC" <<'EOF'
---
id: feature-fast-export
name: 高速エクスポート
scope: medium
---

## 受け入れ基準 (acceptance criteria)

- [ ] 10万件を出力できる。

## 未確定事項 (open questions)

- なし
EOF

OUTPUT="$TMP_ROOT/output"
status="$(run_validator "$REPO" "$LEGACY_SPEC" "$OUTPUT")"
assert_status 1 "$status" "legacy spec must not be implementation-ready"
grep -q 'spec_contract' "$OUTPUT" || fail "legacy failure must identify the missing spec_contract"
grep -q 'implementation_ready' "$OUTPUT" || fail "legacy failure must identify the missing implementation_ready marker"

READY_SPEC="$REPO/specs/ready.md"
write_ready_spec "$READY_SPEC" "$BASE_SHA" "src/export/export.ts"
status="$(run_validator "$REPO" "$READY_SPEC" "$OUTPUT")"
assert_status 0 "$status" "complete v2 spec must be ready"

INVALID_SCOPE_SPEC="$REPO/specs/invalid-scope.md"
cp "$READY_SPEC" "$INVALID_SCOPE_SPEC"
sed -i.bak 's/^scope: medium$/scope: enormous/' "$INVALID_SCOPE_SPEC"
status="$(run_validator "$REPO" "$INVALID_SCOPE_SPEC" "$OUTPUT")"
assert_status 1 "$status" "unknown scope values must be rejected"
grep -qi 'scope' "$OUTPUT" || fail "scope failure must name the invalid scope"

NO_STATUS_SPEC="$REPO/specs/no-status.md"
cp "$READY_SPEC" "$NO_STATUS_SPEC"
sed -i.bak '/^status: approved$/d' "$NO_STATUS_SPEC"
status="$(run_validator "$REPO" "$NO_STATUS_SPEC" "$OUTPUT")"
assert_status 1 "$status" "spec without approved status must be rejected"
grep -qi 'status' "$OUTPUT" || fail "status failure must name the missing approved status"

NO_ID_SPEC="$REPO/specs/no-id.md"
cp "$READY_SPEC" "$NO_ID_SPEC"
sed -i.bak '/^id: /d' "$NO_ID_SPEC"
status="$(run_validator "$REPO" "$NO_ID_SPEC" "$OUTPUT")"
assert_status 1 "$status" "spec without id must be rejected"
grep -qi 'id' "$OUTPUT" || fail "id failure must name the missing id"

INVALID_ID_SPEC="$REPO/specs/invalid-id.md"
cp "$READY_SPEC" "$INVALID_ID_SPEC"
sed -i.bak 's/^id: feature-fast-export$/id: fast-export/' "$INVALID_ID_SPEC"
status="$(run_validator "$REPO" "$INVALID_ID_SPEC" "$OUTPUT")"
assert_status 1 "$status" "spec id without the feature- prefix must be rejected"
grep -qi 'id' "$OUTPUT" || fail "invalid-id failure must name id"

NO_NAME_SPEC="$REPO/specs/no-name.md"
cp "$READY_SPEC" "$NO_NAME_SPEC"
sed -i.bak '/^name: /d' "$NO_NAME_SPEC"
status="$(run_validator "$REPO" "$NO_NAME_SPEC" "$OUTPUT")"
assert_status 1 "$status" "spec without name must be rejected"
grep -qi 'name' "$OUTPUT" || fail "name failure must name the missing name"

NO_SYMBOL_SPEC="$REPO/specs/no-symbol.md"
cp "$READY_SPEC" "$NO_SYMBOL_SPEC"
sed -i.bak '/^- symbols:/d' "$NO_SYMBOL_SPEC"
status="$(run_validator "$REPO" "$NO_SYMBOL_SPEC" "$OUTPUT")"
assert_status 1 "$status" "change entries without symbols must be rejected"
grep -qi 'symbols' "$OUTPUT" || fail "symbol failure must name the missing symbols field"

MISSING_PATH_SPEC="$REPO/specs/missing-path.md"
cp "$READY_SPEC" "$MISSING_PATH_SPEC"
sed -i.bak 's#src/export/export.ts#src/export/missing.ts#' "$MISSING_PATH_SPEC"
status="$(run_validator "$REPO" "$MISSING_PATH_SPEC" "$OUTPUT")"
assert_status 1 "$status" "existing change entries must point to files that exist"
grep -qi 'does not exist' "$OUTPUT" || fail "missing-path failure must explain that the existing file does not exist"

MISSING_SYMBOL_SPEC="$REPO/specs/missing-symbol.md"
cp "$READY_SPEC" "$MISSING_SYMBOL_SPEC"
# Backticks are literal markdown delimiters in the fixture.
# shellcheck disable=SC2016
sed -i.bak 's/`exportRows`/`missingExportRows`/' "$MISSING_SYMBOL_SPEC"
status="$(run_validator "$REPO" "$MISSING_SYMBOL_SPEC" "$OUTPUT")"
assert_status 1 "$status" "existing symbols must be grounded in the referenced file"
grep -qi 'missingExportRows' "$OUTPUT" || fail "missing-symbol failure must name the ungrounded symbol"

NO_TEST_MAP_SPEC="$REPO/specs/no-test-map.md"
cp "$READY_SPEC" "$NO_TEST_MAP_SPEC"
sed -i.bak '/^| AC-1 |/d' "$NO_TEST_MAP_SPEC"
status="$(run_validator "$REPO" "$NO_TEST_MAP_SPEC" "$OUTPUT")"
assert_status 1 "$status" "AC without a test mapping must be rejected"
grep -qi 'AC-1' "$OUTPUT" || fail "test-plan failure must name the unmapped AC"

DUPLICATE_AC_SPEC="$REPO/specs/duplicate-ac.md"
cp "$READY_SPEC" "$DUPLICATE_AC_SPEC"
sed -i.bak '/^- \[ \] AC-1:/a\
- [ ] AC-1: 同じ ID を再利用してはならない。' "$DUPLICATE_AC_SPEC"
status="$(run_validator "$REPO" "$DUPLICATE_AC_SPEC" "$OUTPUT")"
assert_status 1 "$status" "duplicate acceptance-criterion IDs must be rejected"
grep -qi 'duplicate.*AC-1' "$OUTPUT" || fail "duplicate-AC failure must name the duplicated ID"

UNKNOWN_TEST_AC_SPEC="$REPO/specs/unknown-test-ac.md"
cp "$READY_SPEC" "$UNKNOWN_TEST_AC_SPEC"
# Backticks are literal markdown delimiters in the fixture.
# shellcheck disable=SC2016
sed -i.bak '/^| AC-1 |/a\
| AC-BOGUS | `src/export/export.test.ts` | 宣言されていない AC のテスト | unit |' "$UNKNOWN_TEST_AC_SPEC"
status="$(run_validator "$REPO" "$UNKNOWN_TEST_AC_SPEC" "$OUTPUT")"
assert_status 1 "$status" "test-plan rows for undeclared AC IDs must be rejected"
grep -qi 'AC-BOGUS' "$OUTPUT" || fail "unknown-test-AC failure must name the undeclared ID"

EMPTY_TEST_FILE_SPEC="$REPO/specs/empty-test-file.md"
cp "$READY_SPEC" "$EMPTY_TEST_FILE_SPEC"
# Backticks are literal markdown delimiters in the fixture.
# shellcheck disable=SC2016
sed -i.bak 's#| AC-1 | `src/export/export.test.ts` |#| AC-1 |  |#' "$EMPTY_TEST_FILE_SPEC"
status="$(run_validator "$REPO" "$EMPTY_TEST_FILE_SPEC" "$OUTPUT")"
assert_status 1 "$status" "test mappings with an empty file must be rejected"
grep -qi 'Test file' "$OUTPUT" || fail "empty test-file failure must name the empty field"

EMPTY_TEST_CASE_SPEC="$REPO/specs/empty-test-case.md"
cp "$READY_SPEC" "$EMPTY_TEST_CASE_SPEC"
sed -i.bak 's/| 10万件を複数バッチで出力する | integration |/|  | integration |/' "$EMPTY_TEST_CASE_SPEC"
status="$(run_validator "$REPO" "$EMPTY_TEST_CASE_SPEC" "$OUTPUT")"
assert_status 1 "$status" "test mappings with an empty case must be rejected"
grep -qi 'Case' "$OUTPUT" || fail "empty test-case failure must name the empty field"

EMPTY_TEST_LEVEL_SPEC="$REPO/specs/empty-test-level.md"
cp "$READY_SPEC" "$EMPTY_TEST_LEVEL_SPEC"
sed -i.bak 's/| integration |/|  |/' "$EMPTY_TEST_LEVEL_SPEC"
status="$(run_validator "$REPO" "$EMPTY_TEST_LEVEL_SPEC" "$OUTPUT")"
assert_status 1 "$status" "test mappings with an empty level must be rejected"
grep -qi 'Level' "$OUTPUT" || fail "empty test-level failure must name the empty field"

MISSING_CONTRACT_SPEC="$REPO/specs/missing-contract.md"
cp "$READY_SPEC" "$MISSING_CONTRACT_SPEC"
sed -i.bak '/^- Validation:/d' "$MISSING_CONTRACT_SPEC"
status="$(run_validator "$REPO" "$MISSING_CONTRACT_SPEC" "$OUTPUT")"
assert_status 1 "$status" "every required contract facet must be explicit"
grep -qi 'Validation' "$OUTPUT" || fail "missing-contract failure must name the missing facet"

UNEXPLAINED_NA_SPEC="$REPO/specs/unexplained-na.md"
cp "$READY_SPEC" "$UNEXPLAINED_NA_SPEC"
sed -i.bak 's#^- Validation:.*#- Validation: n/a#' "$UNEXPLAINED_NA_SPEC"
status="$(run_validator "$REPO" "$UNEXPLAINED_NA_SPEC" "$OUTPUT")"
assert_status 1 "$status" "n/a contract facets must include a reason"
grep -qi 'n/a' "$OUTPUT" || fail "unexplained n/a failure must request a reason"

MALFORMED_NA_SPEC="$REPO/specs/malformed-na.md"
cp "$READY_SPEC" "$MALFORMED_NA_SPEC"
sed -i.bak 's#^- Validation:.*#- Validation: n/a because this is internal-only#' "$MALFORMED_NA_SPEC"
status="$(run_validator "$REPO" "$MALFORMED_NA_SPEC" "$OUTPUT")"
assert_status 1 "$status" "n/a contract facets must use the documented delimiter before the reason"
grep -qi 'n/a' "$OUTPUT" || fail "malformed n/a failure must identify the required form"

PROSE_QUESTION_SPEC="$REPO/specs/prose-question.md"
cp "$READY_SPEC" "$PROSE_QUESTION_SPEC"
sed -i.bak 's/^- なし$/権限境界を再検討する。/' "$PROSE_QUESTION_SPEC"
status="$(run_validator "$REPO" "$PROSE_QUESTION_SPEC" "$OUTPUT")"
assert_status 1 "$status" "prose in open questions must be treated as blocking"
grep -qi 'blocking open question' "$OUTPUT" || fail "prose-question failure must be explicit"

REUSE_REPO="$TMP_ROOT/reuse-repo"
cp -R "$REPO" "$REUSE_REPO"
git -C "$REUSE_REPO" reset -q --hard "$BASE_SHA"
write_ready_spec "$REUSE_REPO/specs/ready.md" "$BASE_SHA" "src/export/export.ts"
printf 'export function iterateCursor() { return 1 }\n' >"$REUSE_REPO/src/export/cursor.ts"
git -C "$REUSE_REPO" add src/export/cursor.ts
git -C "$REUSE_REPO" commit -qm "change reused dependency"
status="$(run_validator "$REUSE_REPO" "$REUSE_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "changes to reused dependencies must make the spec stale"
grep -qi 'stale' "$OUTPUT" || fail "reused-dependency stale failure must be explicit"

TEST_REPO="$TMP_ROOT/test-repo"
cp -R "$REPO" "$TEST_REPO"
git -C "$TEST_REPO" reset -q --hard "$BASE_SHA"
write_ready_spec "$TEST_REPO/specs/ready.md" "$BASE_SHA" "src/export/export.ts"
printf 'test("exports rows", () => { throw new Error("changed") })\n' >"$TEST_REPO/src/export/export.test.ts"
git -C "$TEST_REPO" add src/export/export.test.ts
git -C "$TEST_REPO" commit -qm "change mapped test"
status="$(run_validator "$TEST_REPO" "$TEST_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "changes to mapped test files must make the spec stale"
grep -qi 'stale' "$OUTPUT" || fail "mapped-test stale failure must be explicit"

printf 'export function exportRows() { return 1 }\n' >"$REPO/src/export/export.ts"
git -C "$REPO" add src/export/export.ts
git -C "$REPO" commit -qm "change referenced implementation"
status="$(run_validator "$REPO" "$READY_SPEC" "$OUTPUT")"
assert_status 1 "$status" "changes to referenced implementation must make the spec stale"
grep -qi 'stale' "$OUTPUT" || fail "stale failure must be explicit"

# --structure-only: staleness だけを免除し、構造検証はすべて行う (resume した
# パイプラインの provenance 再検証用)。stale な spec が structure-only では通り、
# 構造の壊れた spec は structure-only でも落ちることを固定する。
run_validator_structure_only() {
  local repo="$1"
  local spec="$2"
  local output_file="$3"
  local status

  set +e
  (
    cd "$repo"
    "$VALIDATOR" --structure-only "$spec"
  ) >"$output_file" 2>&1
  status=$?
  set -e
  printf '%s' "$status"
}

status="$(run_validator_structure_only "$REPO" "$READY_SPEC" "$OUTPUT")"
assert_status 0 "$status" "--structure-only must exempt exactly the staleness check"

BROKEN_SPEC="$REPO/specs/broken-structure.md"
sed 's/^scope:.*/scope: bogus-scope/' "$READY_SPEC" >"$BROKEN_SPEC"
status="$(run_validator_structure_only "$REPO" "$BROKEN_SPEC" "$OUTPUT")"
assert_status 1 "$status" "--structure-only must still enforce structural validation"

# --structure-only must still enforce grounded_at existence/ancestry — only the
# reference-path diff/dirty check (the actual "staleness" part) is exempt.
MISSING_COMMIT_SPEC="$REPO/specs/missing-commit.md"
sed 's/^grounded_at:.*/grounded_at: ffffffffffffffffffffffffffffffffffffff/' "$READY_SPEC" >"$MISSING_COMMIT_SPEC"
status="$(run_validator_structure_only "$REPO" "$MISSING_COMMIT_SPEC" "$OUTPUT")"
assert_status 1 "$status" "--structure-only must still reject a grounded_at commit that does not exist"
grep -qi 'grounded_at commit does not exist' "$OUTPUT" || fail "missing-commit failure must name the missing commit"

NOT_ANCESTOR_REPO="$TMP_ROOT/not-ancestor-repo"
cp -R "$REPO" "$NOT_ANCESTOR_REPO"
git -C "$NOT_ANCESTOR_REPO" reset -q --hard "$BASE_SHA"
git -C "$NOT_ANCESTOR_REPO" checkout -qb side-branch
printf 'side\n' >"$NOT_ANCESTOR_REPO/SIDE.md"
git -C "$NOT_ANCESTOR_REPO" add SIDE.md
git -C "$NOT_ANCESTOR_REPO" commit -qm "side-branch commit"
SIDE_SHA="$(git -C "$NOT_ANCESTOR_REPO" rev-parse HEAD)"
git -C "$NOT_ANCESTOR_REPO" checkout -q main 2>/dev/null || git -C "$NOT_ANCESTOR_REPO" checkout -q master
write_ready_spec "$NOT_ANCESTOR_REPO/specs/ready.md" "$SIDE_SHA" "src/export/export.ts"
status="$(run_validator_structure_only "$NOT_ANCESTOR_REPO" "$NOT_ANCESTOR_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "--structure-only must still reject a grounded_at that is not an ancestor of HEAD"
grep -qi 'not an ancestor' "$OUTPUT" || fail "not-ancestor failure must be explicit"

UNRELATED_REPO="$TMP_ROOT/unrelated-repo"
cp -R "$REPO" "$UNRELATED_REPO"
git -C "$UNRELATED_REPO" reset -q --hard "$BASE_SHA"
write_ready_spec "$UNRELATED_REPO/specs/ready.md" "$BASE_SHA" "src/export/export.ts"
printf 'unrelated\n' >"$UNRELATED_REPO/README.md"
git -C "$UNRELATED_REPO" add README.md
git -C "$UNRELATED_REPO" commit -qm "change unrelated docs"
status="$(run_validator "$UNRELATED_REPO" "$UNRELATED_REPO/specs/ready.md" "$OUTPUT")"
assert_status 0 "$status" "unrelated changes must not make the spec stale"

# ---------------------------------------------------------------------------
# Symbol-granularity freshness (AC-1..AC-9)
# ---------------------------------------------------------------------------

# AC-1: a messages/ja.json#admin.plugins-shaped pure addition (18 new lines
# under an unrelated namespace) must not disturb the admin.plugins.*
# matching-line sequence -> WARN + READY + exit 0.
WARN_JSON_REPO="$TMP_ROOT/warn-json-repo"
cp -R "$REPO" "$WARN_JSON_REPO"
git -C "$WARN_JSON_REPO" reset -q --hard "$BASE_SHA"
write_messages_fixture "$WARN_JSON_REPO/src/export/messages.ja.json" 0
git -C "$WARN_JSON_REPO" add src/export/messages.ja.json
git -C "$WARN_JSON_REPO" commit -qm "add messages fixture"
WARN_JSON_BASE="$(git -C "$WARN_JSON_REPO" rev-parse HEAD)"
write_ready_spec "$WARN_JSON_REPO/specs/ready.md" "$WARN_JSON_BASE" "src/export/messages.ja.json" "admin.plugins"
write_messages_fixture "$WARN_JSON_REPO/src/export/messages.ja.json" 18
git -C "$WARN_JSON_REPO" add src/export/messages.ja.json
git -C "$WARN_JSON_REPO" commit -qm "add unrelated oauth session keys"
status="$(run_validator "$WARN_JSON_REPO" "$WARN_JSON_REPO/specs/ready.md" "$OUTPUT")"
assert_status 0 "$status" "a pure addition that never touches the grounded symbol lines must warn, not stale"
grep -q '^WARN: referenced path changed but grounded symbol lines are identical: src/export/messages.ja.json (symbols: admin.plugins)$' "$OUTPUT" \
  || fail "AC-1 must emit a path/symbol WARN line"
grep -q '^READY:' "$OUTPUT" || fail "AC-1 must still emit READY"

# AC-2: a client.ts#CrowiApiClient-shaped chain addition must not disturb the
# CrowiApiClient matching-line sequence -> WARN + READY + exit 0.
WARN_CHAIN_REPO="$TMP_ROOT/warn-chain-repo"
cp -R "$REPO" "$WARN_CHAIN_REPO"
git -C "$WARN_CHAIN_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$WARN_CHAIN_REPO/src/export/client-chain.ts" 3
git -C "$WARN_CHAIN_REPO" add src/export/client-chain.ts
git -C "$WARN_CHAIN_REPO" commit -qm "add chain fixture"
WARN_CHAIN_BASE="$(git -C "$WARN_CHAIN_REPO" rev-parse HEAD)"
write_ready_spec "$WARN_CHAIN_REPO/specs/ready.md" "$WARN_CHAIN_BASE" "src/export/client-chain.ts" "CrowiApiClient"
write_chain_fixture "$WARN_CHAIN_REPO/src/export/client-chain.ts" 4
git -C "$WARN_CHAIN_REPO" add src/export/client-chain.ts
git -C "$WARN_CHAIN_REPO" commit -qm "add a fourth chain"
status="$(run_validator "$WARN_CHAIN_REPO" "$WARN_CHAIN_REPO/specs/ready.md" "$OUTPUT")"
assert_status 0 "$status" "adding a chain that never touches the CrowiApiClient matching lines must warn, not stale"
grep -q '^WARN: referenced path changed but grounded symbol lines are identical: src/export/client-chain.ts (symbols: CrowiApiClient)$' "$OUTPUT" \
  || fail "AC-2 must emit a path/symbol WARN line"
grep -q '^READY:' "$OUTPUT" || fail "AC-2 must still emit READY"

# AC-3: rewriting a grounded symbol's matching line (not just an addition
# elsewhere) must produce a path#symbol hard stale ERROR, no WARN/READY.
STALE_CHAIN_REPO="$TMP_ROOT/stale-chain-repo"
cp -R "$REPO" "$STALE_CHAIN_REPO"
git -C "$STALE_CHAIN_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$STALE_CHAIN_REPO/src/export/client-chain.ts" 3
git -C "$STALE_CHAIN_REPO" add src/export/client-chain.ts
git -C "$STALE_CHAIN_REPO" commit -qm "add chain fixture"
STALE_CHAIN_BASE="$(git -C "$STALE_CHAIN_REPO" rev-parse HEAD)"
write_ready_spec "$STALE_CHAIN_REPO/specs/ready.md" "$STALE_CHAIN_BASE" "src/export/client-chain.ts" "CrowiApiClient"
sed -i.bak 's/composes every route chain/combines every route chain/' "$STALE_CHAIN_REPO/src/export/client-chain.ts"
git -C "$STALE_CHAIN_REPO" add src/export/client-chain.ts
git -C "$STALE_CHAIN_REPO" commit -qm "reword the CrowiApiClient doc comment"
status="$(run_validator "$STALE_CHAIN_REPO" "$STALE_CHAIN_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "rewriting a grounded symbol's matching line must be a hard stale error"
grep -q '^ERROR: spec is stale: referenced path changed and symbol lines differ: src/export/client-chain.ts#CrowiApiClient$' "$OUTPUT" \
  || fail "AC-3 error must use the path#symbol hard-stale message format"
grep -q '^WARN:' "$OUTPUT" && fail "AC-3 must not emit a WARN alongside a hard error"
grep -q '^READY:' "$OUTPUT" && fail "AC-3 must not emit READY"

# AC-3 (add case): a brand-new matching line for a grounded symbol grows the
# matching-line sequence even though nothing existing was touched — this must
# also be a path#symbol hard stale, not a WARN, since the sequence changed.
ADD_CHAIN_REPO="$TMP_ROOT/add-chain-repo"
cp -R "$REPO" "$ADD_CHAIN_REPO"
git -C "$ADD_CHAIN_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$ADD_CHAIN_REPO/src/export/client-chain.ts" 3
git -C "$ADD_CHAIN_REPO" add src/export/client-chain.ts
git -C "$ADD_CHAIN_REPO" commit -qm "add chain fixture"
ADD_CHAIN_BASE="$(git -C "$ADD_CHAIN_REPO" rev-parse HEAD)"
write_ready_spec "$ADD_CHAIN_REPO/specs/ready.md" "$ADD_CHAIN_BASE" "src/export/client-chain.ts" "CrowiApiClient"
printf '\n// see also CrowiApiClient in the composed intersection above\n' >>"$ADD_CHAIN_REPO/src/export/client-chain.ts"
git -C "$ADD_CHAIN_REPO" add src/export/client-chain.ts
git -C "$ADD_CHAIN_REPO" commit -qm "add a new CrowiApiClient mention"
status="$(run_validator "$ADD_CHAIN_REPO" "$ADD_CHAIN_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "adding a new matching line for a grounded symbol must be a hard stale error"
grep -q '^ERROR: spec is stale: referenced path changed and symbol lines differ: src/export/client-chain.ts#CrowiApiClient$' "$OUTPUT" \
  || fail "AC-3 add-case error must use the path#symbol hard-stale message format"
grep -q '^WARN:' "$OUTPUT" && fail "AC-3 add-case must not emit a WARN alongside a hard error"
grep -q '^READY:' "$OUTPUT" && fail "AC-3 add-case must not emit READY"

# AC-3 (delete case): removing a matching line for a grounded symbol shrinks
# the matching-line sequence — also a path#symbol hard stale.
DELETE_CHAIN_REPO="$TMP_ROOT/delete-chain-repo"
cp -R "$REPO" "$DELETE_CHAIN_REPO"
git -C "$DELETE_CHAIN_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$DELETE_CHAIN_REPO/src/export/client-chain.ts" 3
git -C "$DELETE_CHAIN_REPO" add src/export/client-chain.ts
git -C "$DELETE_CHAIN_REPO" commit -qm "add chain fixture"
DELETE_CHAIN_BASE="$(git -C "$DELETE_CHAIN_REPO" rev-parse HEAD)"
write_ready_spec "$DELETE_CHAIN_REPO/specs/ready.md" "$DELETE_CHAIN_BASE" "src/export/client-chain.ts" "CrowiApiClient"
sed -i.bak '/CrowiApiClient composes every route chain/d' "$DELETE_CHAIN_REPO/src/export/client-chain.ts"
git -C "$DELETE_CHAIN_REPO" add src/export/client-chain.ts
git -C "$DELETE_CHAIN_REPO" commit -qm "remove the CrowiApiClient doc comment line"
status="$(run_validator "$DELETE_CHAIN_REPO" "$DELETE_CHAIN_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "removing a matching line for a grounded symbol must be a hard stale error"
grep -q '^ERROR: spec is stale: referenced path changed and symbol lines differ: src/export/client-chain.ts#CrowiApiClient$' "$OUTPUT" \
  || fail "AC-3 delete-case error must use the path#symbol hard-stale message format"
grep -q '^WARN:' "$OUTPUT" && fail "AC-3 delete-case must not emit a WARN alongside a hard error"
grep -q '^READY:' "$OUTPUT" && fail "AC-3 delete-case must not emit READY"

# AC-4: a live-grounded regular file whose mode changes (identical content)
# is the representative fallback to file-level hard stale.
MODE_MISMATCH_REPO="$TMP_ROOT/mode-mismatch-repo"
cp -R "$REPO" "$MODE_MISMATCH_REPO"
git -C "$MODE_MISMATCH_REPO" reset -q --hard "$BASE_SHA"
write_ready_spec "$MODE_MISMATCH_REPO/specs/ready.md" "$BASE_SHA" "src/export/export.ts"
chmod +x "$MODE_MISMATCH_REPO/src/export/export.ts"
git -C "$MODE_MISMATCH_REPO" add src/export/export.ts
git -C "$MODE_MISMATCH_REPO" commit -qm "flip the executable bit"
status="$(run_validator "$MODE_MISMATCH_REPO" "$MODE_MISMATCH_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "a regular-file mode change must fall back to file-level hard stale"
grep -q '^ERROR: spec is stale: referenced path changed after grounded_at: src/export/export.ts$' "$OUTPUT" \
  || fail "AC-4 mode-mismatch failure must use the singular per-path file-level stale message"

# AC-4 (path-only reuse fallback): a path-only (no #symbol) reuse target must
# use the same file-level fallback as any other strict record — a changed
# path-only reuse is never eligible for symbol granularity even though its
# content change would otherwise leave a matching-line sequence untouched.
PATH_ONLY_REUSE_REPO="$TMP_ROOT/path-only-reuse-repo"
cp -R "$REPO" "$PATH_ONLY_REUSE_REPO"
git -C "$PATH_ONLY_REUSE_REPO" reset -q --hard "$BASE_SHA"
PATH_ONLY_REUSE_SPEC="$PATH_ONLY_REUSE_REPO/specs/ready.md"
write_ready_spec "$PATH_ONLY_REUSE_SPEC" "$BASE_SHA" "src/export/export.ts"
# Backticks are literal markdown delimiters in the fixture. `|` is the sed
# delimiter here since the search text itself contains a literal `#`.
# shellcheck disable=SC2016
sed -i.bak 's|- reuse: `src/export/cursor.ts#iterateCursor`|- reuse: `src/export/cursor.ts`|' "$PATH_ONLY_REUSE_SPEC"
# shellcheck disable=SC2016
grep -q '^- reuse: `src/export/cursor.ts`$' "$PATH_ONLY_REUSE_SPEC" \
  || fail "path-only reuse fixture setup did not rewrite the reuse line"
printf 'export function iterateCursor() { return 1 }\n' >"$PATH_ONLY_REUSE_REPO/src/export/cursor.ts"
git -C "$PATH_ONLY_REUSE_REPO" add src/export/cursor.ts
git -C "$PATH_ONLY_REUSE_REPO" commit -qm "change a path-only reuse target"
status="$(run_validator "$PATH_ONLY_REUSE_REPO" "$PATH_ONLY_REUSE_SPEC" "$OUTPUT")"
assert_status 1 "$status" "a changed path-only reuse target must fall back to file-level hard stale"
grep -q '^ERROR: spec is stale: referenced path changed after grounded_at: src/export/cursor.ts$' "$OUTPUT" \
  || fail "path-only reuse stale failure must use the singular per-path file-level stale message"
grep -q '^WARN:' "$OUTPUT" && fail "path-only reuse stale must not emit a WARN"
grep -q '^READY:' "$OUTPUT" && fail "path-only reuse stale must not emit READY"

# AC-5: a symbol grep exiting >=2 on either side must fail closed as
# inspection-failed, not as an empty-sequence match.
GREP_FAIL_REPO="$TMP_ROOT/grep-fail-repo"
cp -R "$REPO" "$GREP_FAIL_REPO"
git -C "$GREP_FAIL_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$GREP_FAIL_REPO/src/export/client-chain.ts" 3
git -C "$GREP_FAIL_REPO" add src/export/client-chain.ts
git -C "$GREP_FAIL_REPO" commit -qm "add chain fixture"
GREP_FAIL_BASE="$(git -C "$GREP_FAIL_REPO" rev-parse HEAD)"
write_ready_spec "$GREP_FAIL_REPO/specs/ready.md" "$GREP_FAIL_BASE" "src/export/client-chain.ts" "CrowiApiClient"
write_chain_fixture "$GREP_FAIL_REPO/src/export/client-chain.ts" 4
git -C "$GREP_FAIL_REPO" add src/export/client-chain.ts
git -C "$GREP_FAIL_REPO" commit -qm "add a fourth chain"

GREP_SHIM_DIR="$TMP_ROOT/grep-shim"
mkdir -p "$GREP_SHIM_DIR"
cat >"$GREP_SHIM_DIR/grep" <<'SHIM'
#!/usr/bin/env bash
if [[ "$1" == "-F" ]]; then
  exit 2
fi
exec "$REAL_GREP_BIN" "$@"
SHIM
chmod +x "$GREP_SHIM_DIR/grep"
status="$(run_validator_with_path "$GREP_FAIL_REPO" "$GREP_FAIL_REPO/specs/ready.md" "$OUTPUT" "$GREP_SHIM_DIR")"
assert_status 1 "$status" "a symbol grep exit status >=2 must fail closed"
grep -qi 'staleness check failed' "$OUTPUT" || fail "AC-5 failure must say staleness check failed"
grep -q '^WARN:' "$OUTPUT" && fail "AC-5 must not emit a WARN"
grep -q '^READY:' "$OUTPUT" && fail "AC-5 must not emit READY"

# Error semantics (git ls-tree execution failure): per the "git/od/cmp の実行
# 失敗は判定不能 ERROR" contract, a genuine `git ls-tree` execution failure
# (not "the path has no entry", which is the legitimate mode-mismatch-shaped
# file-level fallback) must fail closed as inspection-failed, never as a
# quiet file-level stale.
LSTREE_FAIL_REPO="$TMP_ROOT/lstree-fail-repo"
cp -R "$REPO" "$LSTREE_FAIL_REPO"
git -C "$LSTREE_FAIL_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$LSTREE_FAIL_REPO/src/export/client-chain.ts" 3
git -C "$LSTREE_FAIL_REPO" add src/export/client-chain.ts
git -C "$LSTREE_FAIL_REPO" commit -qm "add chain fixture"
LSTREE_FAIL_BASE="$(git -C "$LSTREE_FAIL_REPO" rev-parse HEAD)"
write_ready_spec "$LSTREE_FAIL_REPO/specs/ready.md" "$LSTREE_FAIL_BASE" "src/export/client-chain.ts" "CrowiApiClient"
write_chain_fixture "$LSTREE_FAIL_REPO/src/export/client-chain.ts" 4
git -C "$LSTREE_FAIL_REPO" add src/export/client-chain.ts
git -C "$LSTREE_FAIL_REPO" commit -qm "add a fourth chain"

LSTREE_SHIM_DIR="$TMP_ROOT/lstree-shim"
mkdir -p "$LSTREE_SHIM_DIR"
cat >"$LSTREE_SHIM_DIR/git" <<'SHIM'
#!/usr/bin/env bash
if [[ "$1" == "ls-tree" ]]; then
  echo "fatal: simulated ls-tree failure" >&2
  exit 128
fi
exec "$REAL_GIT_BIN" "$@"
SHIM
chmod +x "$LSTREE_SHIM_DIR/git"
status="$(run_validator_with_path "$LSTREE_FAIL_REPO" "$LSTREE_FAIL_REPO/specs/ready.md" "$OUTPUT" "$LSTREE_SHIM_DIR")"
assert_status 1 "$status" "a git ls-tree execution failure must fail closed as inspection-failed"
grep -qi 'staleness check failed' "$OUTPUT" || fail "ls-tree-failure error must say staleness check failed"
grep -q '^WARN:' "$OUTPUT" && fail "ls-tree-failure must not emit a WARN"
grep -q '^READY:' "$OUTPUT" && fail "ls-tree-failure must not emit READY"

# Error semantics (cmp execution failure): a `cmp` exit status >=2 (I/O
# failure) must not be treated as "sequences differ" (exit 1) — it is
# inspection-failed, matching the same contract as the grep and ls-tree
# execution-failure cases above.
CMP_FAIL_REPO="$TMP_ROOT/cmp-fail-repo"
cp -R "$REPO" "$CMP_FAIL_REPO"
git -C "$CMP_FAIL_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$CMP_FAIL_REPO/src/export/client-chain.ts" 3
git -C "$CMP_FAIL_REPO" add src/export/client-chain.ts
git -C "$CMP_FAIL_REPO" commit -qm "add chain fixture"
CMP_FAIL_BASE="$(git -C "$CMP_FAIL_REPO" rev-parse HEAD)"
write_ready_spec "$CMP_FAIL_REPO/specs/ready.md" "$CMP_FAIL_BASE" "src/export/client-chain.ts" "CrowiApiClient"
write_chain_fixture "$CMP_FAIL_REPO/src/export/client-chain.ts" 4
git -C "$CMP_FAIL_REPO" add src/export/client-chain.ts
git -C "$CMP_FAIL_REPO" commit -qm "add a fourth chain"

CMP_SHIM_DIR="$TMP_ROOT/cmp-shim"
mkdir -p "$CMP_SHIM_DIR"
cat >"$CMP_SHIM_DIR/cmp" <<'SHIM'
#!/usr/bin/env bash
echo "cmp: simulated I/O failure" >&2
exit 2
SHIM
chmod +x "$CMP_SHIM_DIR/cmp"
status="$(run_validator_with_path "$CMP_FAIL_REPO" "$CMP_FAIL_REPO/specs/ready.md" "$OUTPUT" "$CMP_SHIM_DIR")"
assert_status 1 "$status" "a cmp execution failure must fail closed as inspection-failed, not as sequences-differ"
grep -qi 'staleness check failed' "$OUTPUT" || fail "cmp-failure error must say staleness check failed"
grep -q '^ERROR: spec is stale: referenced path changed and symbol lines differ:' "$OUTPUT" \
  && fail "cmp-failure must not be reported as a sequences-differ hard stale"
grep -q '^WARN:' "$OUTPUT" && fail "cmp-failure must not emit a WARN"
grep -q '^READY:' "$OUTPUT" && fail "cmp-failure must not emit READY"

# AC-6a: the final clean recheck covers every path that would otherwise
# succeed, not just warning candidates. A strict Test file reference that was
# clean on its own per-path check but goes dirty by the time the batched
# final recheck runs must still suppress READY.
FINAL_DIRTY_REPO="$TMP_ROOT/final-dirty-repo"
cp -R "$REPO" "$FINAL_DIRTY_REPO"
git -C "$FINAL_DIRTY_REPO" reset -q --hard "$BASE_SHA"
write_ready_spec "$FINAL_DIRTY_REPO/specs/ready.md" "$BASE_SHA" "src/export/export.ts"

GIT_STATUS_SHIM_DIR="$TMP_ROOT/git-status-shim"
mkdir -p "$GIT_STATUS_SHIM_DIR"
cat >"$GIT_STATUS_SHIM_DIR/git" <<'SHIM'
#!/usr/bin/env bash
if [[ "$1" == "status" ]]; then
  match=0
  for a in "$@"; do
    [[ "$a" == *"$GIT_SHIM_TARGET"* ]] && match=1
  done
  if [[ "$match" -eq 1 ]]; then
    n=0
    [[ -f "$GIT_SHIM_COUNTER" ]] && n="$(cat "$GIT_SHIM_COUNTER")"
    n=$((n + 1))
    echo "$n" >"$GIT_SHIM_COUNTER"
    if [[ "$n" -ge 2 ]]; then
      echo " M $GIT_SHIM_TARGET"
      exit 0
    fi
  fi
fi
exec "$REAL_GIT_BIN" "$@"
SHIM
chmod +x "$GIT_STATUS_SHIM_DIR/git"

GIT_SHIM_TARGET="src/export/export.test.ts"
GIT_SHIM_COUNTER="$TMP_ROOT/git-shim-counter"
rm -f "$GIT_SHIM_COUNTER"
export GIT_SHIM_TARGET GIT_SHIM_COUNTER
status="$(run_validator_with_path "$FINAL_DIRTY_REPO" "$FINAL_DIRTY_REPO/specs/ready.md" "$OUTPUT" "$GIT_STATUS_SHIM_DIR")"
assert_status 1 "$status" "a strict reference going dirty before the final recheck must suppress READY"
grep -q '^ERROR: spec is stale: referenced path has uncommitted changes: src/export/export.test.ts$' "$OUTPUT" \
  || fail "AC-6a failure must use the singular per-path file-level stale message"
grep -q '^READY:' "$OUTPUT" && fail "AC-6a must not emit READY"
unset GIT_SHIM_TARGET GIT_SHIM_COUNTER

# AC-6b: if HEAD itself moves during validation (observed only at the final
# HEAD recheck), the invocation must fail closed and ask for a rerun rather
# than emit a stale WARN/READY based on a HEAD that no longer holds. Built on
# a WARN-eligible fixture (chain addition, same shape as AC-2) so this test
# can actually observe WARN suppression rather than a run that never had a
# WARN candidate to suppress in the first place.
HEAD_MOVE_REPO="$TMP_ROOT/head-move-repo"
cp -R "$REPO" "$HEAD_MOVE_REPO"
git -C "$HEAD_MOVE_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$HEAD_MOVE_REPO/src/export/client-chain.ts" 3
git -C "$HEAD_MOVE_REPO" add src/export/client-chain.ts
git -C "$HEAD_MOVE_REPO" commit -qm "add chain fixture"
HEAD_MOVE_BASE="$(git -C "$HEAD_MOVE_REPO" rev-parse HEAD)"
write_ready_spec "$HEAD_MOVE_REPO/specs/ready.md" "$HEAD_MOVE_BASE" "src/export/client-chain.ts" "CrowiApiClient"
write_chain_fixture "$HEAD_MOVE_REPO/src/export/client-chain.ts" 4
git -C "$HEAD_MOVE_REPO" add src/export/client-chain.ts
git -C "$HEAD_MOVE_REPO" commit -qm "add a fourth chain"

GIT_REVPARSE_SHIM_DIR="$TMP_ROOT/git-revparse-shim"
mkdir -p "$GIT_REVPARSE_SHIM_DIR"
cat >"$GIT_REVPARSE_SHIM_DIR/git" <<'SHIM'
#!/usr/bin/env bash
if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  n=0
  [[ -f "$REVPARSE_COUNTER" ]] && n="$(cat "$REVPARSE_COUNTER")"
  n=$((n + 1))
  echo "$n" >"$REVPARSE_COUNTER"
  out="$("$REAL_GIT_BIN" "$@")"
  status=$?
  echo "$out"
  if [[ "$n" -eq 1 ]]; then
    "$REAL_GIT_BIN" commit --allow-empty -q -m "advance HEAD mid-validation" >/dev/null 2>&1
  fi
  exit "$status"
fi
exec "$REAL_GIT_BIN" "$@"
SHIM
chmod +x "$GIT_REVPARSE_SHIM_DIR/git"

REVPARSE_COUNTER="$TMP_ROOT/git-revparse-counter"
rm -f "$REVPARSE_COUNTER"
export REVPARSE_COUNTER
status="$(run_validator_with_path "$HEAD_MOVE_REPO" "$HEAD_MOVE_REPO/specs/ready.md" "$OUTPUT" "$GIT_REVPARSE_SHIM_DIR")"
assert_status 1 "$status" "HEAD moving during validation must fail closed even when a WARN would otherwise have been earned"
grep -qi 'HEAD changed during validation' "$OUTPUT" || fail "AC-6b failure must name the HEAD-changed condition"
grep -q '^WARN:' "$OUTPUT" && fail "AC-6b must not emit a WARN that was earned before HEAD moved"
grep -q '^READY:' "$OUTPUT" && fail "AC-6b must not emit READY"
unset REVPARSE_COUNTER

# AC-6c: the final HEAD recheck must run even when every reference path is a
# generated artifact (so UNIQUE_REFERENCE_PATHS is empty after filtering) —
# it must not be gated on having any non-generated reference path to compare.
ALL_GENERATED_HEAD_MOVE_REPO="$TMP_ROOT/all-generated-head-move-repo"
cp -R "$REPO" "$ALL_GENERATED_HEAD_MOVE_REPO"
git -C "$ALL_GENERATED_HEAD_MOVE_REPO" reset -q --hard "$BASE_SHA"
mkdir -p "$ALL_GENERATED_HEAD_MOVE_REPO/src/export/generated"
printf 'export const schemaValue = 1;\n' >"$ALL_GENERATED_HEAD_MOVE_REPO/src/export/generated/schema.ts"
printf 'export const cursorValue = 1;\n' >"$ALL_GENERATED_HEAD_MOVE_REPO/src/export/generated/cursor.ts"
git -C "$ALL_GENERATED_HEAD_MOVE_REPO" add src/export/generated/schema.ts src/export/generated/cursor.ts
git -C "$ALL_GENERATED_HEAD_MOVE_REPO" commit -qm "add only generated-looking artifacts"
ALL_GENERATED_HEAD_MOVE_BASE="$(git -C "$ALL_GENERATED_HEAD_MOVE_REPO" rev-parse HEAD)"
ALL_GENERATED_HEAD_MOVE_SPEC="$ALL_GENERATED_HEAD_MOVE_REPO/specs/ready.md"
write_ready_spec "$ALL_GENERATED_HEAD_MOVE_SPEC" "$ALL_GENERATED_HEAD_MOVE_BASE" "src/export/generated/schema.ts" "schemaValue"
# Backticks are literal markdown delimiters in the fixture.
# shellcheck disable=SC2016
sed -i.bak 's|- reuse: `src/export/cursor.ts#iterateCursor`|- reuse: `src/export/generated/cursor.ts`|' "$ALL_GENERATED_HEAD_MOVE_SPEC"
# Backticks are literal markdown delimiters in the fixture.
# shellcheck disable=SC2016
sed -i.bak 's#| AC-1 | `src/export/export.test.ts` |#| AC-1 | `src/export/generated/schema.ts` |#' "$ALL_GENERATED_HEAD_MOVE_SPEC"

REVPARSE_COUNTER="$TMP_ROOT/git-revparse-counter-all-generated"
rm -f "$REVPARSE_COUNTER"
export REVPARSE_COUNTER
status="$(run_validator_with_path "$ALL_GENERATED_HEAD_MOVE_REPO" "$ALL_GENERATED_HEAD_MOVE_SPEC" "$OUTPUT" "$GIT_REVPARSE_SHIM_DIR")"
assert_status 1 "$status" "HEAD moving during validation must fail closed even when every reference path is a generated artifact"
grep -qi 'HEAD changed during validation' "$OUTPUT" || fail "AC-6c failure must name the HEAD-changed condition"
grep -q '^READY:' "$OUTPUT" && fail "AC-6c must not emit a bare READY when HEAD moved but no non-generated path triggered a recheck"
unset REVPARSE_COUNTER

# AC-7: a Change status:new path that exists but only as gitignored/untracked
# must still be rejected by the existing `-e` check (not by a status-based
# check, which would miss it).
IGNORED_NEW_REPO="$TMP_ROOT/ignored-new-repo"
cp -R "$REPO" "$IGNORED_NEW_REPO"
git -C "$IGNORED_NEW_REPO" reset -q --hard "$BASE_SHA"
printf 'node_modules/\n' >"$IGNORED_NEW_REPO/.gitignore"
git -C "$IGNORED_NEW_REPO" add .gitignore
git -C "$IGNORED_NEW_REPO" commit -qm "add gitignore"
IGNORED_NEW_BASE="$(git -C "$IGNORED_NEW_REPO" rev-parse HEAD)"
mkdir -p "$IGNORED_NEW_REPO/node_modules"
printf 'export const generatedThing = 1;\n' >"$IGNORED_NEW_REPO/node_modules/generated.ts"
IGNORED_NEW_SPEC="$IGNORED_NEW_REPO/specs/ignored-new.md"
cat >"$IGNORED_NEW_SPEC" <<EOF
---
id: feature-fast-export
name: 高速エクスポート
scope: medium
spec_contract: 2
status: approved
implementation_ready: true
grounded_at: $IGNORED_NEW_BASE
---

## 背景 / why

既存のエクスポート処理を高速化する。

## やること (ユーザー視点)

大量データをタイムアウトせずエクスポートできる。

## やらないこと (out of scope)

- 新しいファイル形式の追加

## 設計の主な判断

- 既存のストリーミング境界を維持する。

## 実装マップ (implementation map)

### Change: \`node_modules/generated.ts\`

- status: new
- symbols: \`generatedThing\`
- changes: 生成物を新設する。
- reuse: none — 初出のため

## 処理・データフロー (control / data flow)

1. handler が認可を確認する。
2. cursor でデータを取得する。
3. serializer が出力へ順次書き込む。

## 契約・不変条件 (contracts / invariants)

- Public API/types: 既存の export API と返却型を維持する。
- Authentication/authorization: 既存の export 権限チェックを維持する。
- Validation: 既存の export filter validation を維持する。
- Error semantics: 書き込み失敗は既存の export error に変換する。
- Transaction/concurrency: read transaction をバッチ間で共有しない。
- Backward compatibility/migration: migration は不要。既存 API と互換にする。
- Performance/resource limit: 1 バッチ 1000 件以下で処理する。

## 受け入れ基準 (acceptance criteria)

- [ ] AC-1: 10万件をストリーミングで出力できる。

## テスト計画 (test plan)

| AC | Test file | Case | Level |
|---|---|---|---|
| AC-1 | \`src/export/export.test.ts\` | 10万件を複数バッチで出力する | integration |

## 実装順序 (implementation order)

1. cursor 利用へ切り替える。
2. integration test を追加する。

## 未確定事項 (open questions)

- なし
EOF
status="$(run_validator "$IGNORED_NEW_REPO" "$IGNORED_NEW_SPEC" "$OUTPUT")"
assert_status 1 "$status" "a gitignored untracked path marked as new must still be rejected by -e"
grep -qi 'existing path as new' "$OUTPUT" || fail "AC-7 failure must name the -e rejection"

# AC-8: a hard error elsewhere in the same invocation must suppress every
# WARN, even one already earned by another path in the same spec.
MIXED_REPO="$TMP_ROOT/mixed-warn-error-repo"
cp -R "$REPO" "$MIXED_REPO"
git -C "$MIXED_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$MIXED_REPO/src/export/client-chain.ts" 3
git -C "$MIXED_REPO" add src/export/client-chain.ts
git -C "$MIXED_REPO" commit -qm "add chain fixture"
MIXED_BASE="$(git -C "$MIXED_REPO" rev-parse HEAD)"
write_ready_spec "$MIXED_REPO/specs/ready.md" "$MIXED_BASE" "src/export/client-chain.ts" "CrowiApiClient"
write_chain_fixture "$MIXED_REPO/src/export/client-chain.ts" 4
printf 'export function iterateCursor() { return 1 }\n' >"$MIXED_REPO/src/export/cursor.ts"
git -C "$MIXED_REPO" add src/export/client-chain.ts src/export/cursor.ts
git -C "$MIXED_REPO" commit -qm "add a fourth chain and change a strict reuse target"
status="$(run_validator "$MIXED_REPO" "$MIXED_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "a hard error on one path must suppress a WARN earned by another path"
grep -qi 'stale' "$OUTPUT" || fail "AC-8 mixed case must still report the hard error"
grep -q '^WARN:' "$OUTPUT" && fail "AC-8 must not emit any WARN alongside a hard error"
grep -q '^READY:' "$OUTPUT" && fail "AC-8 must not emit READY"

# AC-8 (umbrella): a successful child's WARN is forwarded with a phase
# prefix, not discarded.
UMBRELLA_REPO="$TMP_ROOT/umbrella-warn-repo"
cp -R "$REPO" "$UMBRELLA_REPO"
git -C "$UMBRELLA_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$UMBRELLA_REPO/src/export/client-chain.ts" 3
git -C "$UMBRELLA_REPO" add src/export/client-chain.ts
git -C "$UMBRELLA_REPO" commit -qm "add chain fixture"
UMBRELLA_PHASE_BASE="$(git -C "$UMBRELLA_REPO" rev-parse HEAD)"
PHASE_SPEC="$UMBRELLA_REPO/specs/feature-fast-export-phase0.md"
write_ready_spec "$PHASE_SPEC" "$UMBRELLA_PHASE_BASE" "src/export/client-chain.ts" "CrowiApiClient"
sed -i.bak 's/^id: feature-fast-export$/id: feature-fast-export-phase0/' "$PHASE_SPEC"
write_chain_fixture "$UMBRELLA_REPO/src/export/client-chain.ts" 4
git -C "$UMBRELLA_REPO" add src/export/client-chain.ts
git -C "$UMBRELLA_REPO" commit -qm "add a fourth chain"
UMBRELLA_SPEC="$UMBRELLA_REPO/specs/feature-fast-export-umbrella.md"
cat >"$UMBRELLA_SPEC" <<'EOF'
---
spec_contract: 2
kind: umbrella
id: feature-fast-export-umbrella
status: approved
phases:
  - feature-fast-export-phase0
---

umbrella の運用契約とフェーズ表(人間向け)。
EOF
status="$(run_validator "$UMBRELLA_REPO" "$UMBRELLA_SPEC" "$OUTPUT")"
assert_status 0 "$status" "an umbrella whose only child warns must still be ready"
grep -q '^WARN: phase feature-fast-export-phase0: referenced path changed but grounded symbol lines are identical: src/export/client-chain.ts (symbols: CrowiApiClient)$' "$OUTPUT" \
  || fail "umbrella must forward the child WARN with a phase prefix"
grep -q '^READY:' "$OUTPUT" || fail "umbrella must still emit READY"

# AC-8 (docs contract): kickoff and orchestrate B must document forwarding
# raw WARN: lines grouped by spec id, not just the READY/ERROR contract. Each
# assertion below targets one specific clause of the contract (grouping by
# spec id, verbatim/no-rewrite preservation, the per-spec-id heading format,
# and — for orchestrate — the "not a standalone trigger" carve-out) rather
# than a generic "WARN: appears somewhere" smoke check.
KICKOFF_SKILL="$SCRIPT_DIR/../../crowi-kickoff/SKILL.md"
[[ -f "$KICKOFF_SKILL" ]] || fail "crowi-kickoff SKILL.md not found at $KICKOFF_SKILL"
grep -q 'WARN:' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document the WARN: contract"
grep -qi 'staleness warning' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document staleness warnings reporting"
grep -q 'spec id ごと' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document grouping warnings by spec id"
grep -q '原文のまま' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document verbatim (no summarize/rewrite) WARN transcription"
grep -q '^## feature-<id>$' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document the per-spec-id heading format for staleness warnings"
grep -q 'stdout' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document preserving stdout per spec id"
grep -q 'stderr' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document preserving stderr per spec id"
grep -q 'exit status' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document preserving exit status per spec id"
grep -q '対応づけて' "$KICKOFF_SKILL" || fail "crowi-kickoff SKILL.md must document stdout/stderr/exit status keyed by spec id, not just WARN lines"

ORCHESTRATE_SKILL="$SCRIPT_DIR/../../crowi-orchestrate/SKILL.md"
[[ -f "$ORCHESTRATE_SKILL" ]] || fail "crowi-orchestrate SKILL.md not found at $ORCHESTRATE_SKILL"
grep -q 'WARN:' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document the WARN: contract"
grep -qi 'staleness warning' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document staleness warnings reporting"
grep -q 'spec id ごと' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document grouping warnings by spec id"
grep -q '原文のまま' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document verbatim (no summarize/rewrite) WARN transcription"
grep -q 'それ単独では出力条件にしない' "$ORCHESTRATE_SKILL" \
  || fail "crowi-orchestrate SKILL.md must document that a WARN alone is not a standalone report trigger"
grep -q 'stdout' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document preserving stdout per spec id"
grep -q 'stderr' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document preserving stderr per spec id"
grep -q 'exit status' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document preserving exit status per spec id"
grep -q '対応づけて' "$ORCHESTRATE_SKILL" || fail "crowi-orchestrate SKILL.md must document stdout/stderr/exit status keyed by spec id, not just WARN lines"

# AC-9: a reorder of matching lines with distinct byte content must be a
# hard stale error (sequence changed).
REORDER_REPO="$TMP_ROOT/reorder-repo"
cp -R "$REPO" "$REORDER_REPO"
git -C "$REORDER_REPO" reset -q --hard "$BASE_SHA"
write_chain_fixture "$REORDER_REPO/src/export/client-chain.ts" 3
git -C "$REORDER_REPO" add src/export/client-chain.ts
git -C "$REORDER_REPO" commit -qm "add chain fixture"
REORDER_BASE="$(git -C "$REORDER_REPO" rev-parse HEAD)"
write_ready_spec "$REORDER_REPO/specs/ready.md" "$REORDER_BASE" "src/export/client-chain.ts" "CrowiApiClient"
# Swap the doc-comment line and the type-declaration line: both contain the
# symbol, both differ in byte content, so the matching-line sequence order
# changes even though the same two lines are still present.
REORDER_FILE="$REORDER_REPO/src/export/client-chain.ts"
mapfile -t reorder_lines <"$REORDER_FILE"
comment_idx=-1
type_idx=-1
for i in "${!reorder_lines[@]}"; do
  case "${reorder_lines[$i]}" in
    *"CrowiApiClient composes"*) comment_idx="$i" ;;
    "export type CrowiApiClient"*) type_idx="$i" ;;
  esac
done
[[ "$comment_idx" -ge 0 && "$type_idx" -ge 0 ]] || fail "AC-9 fixture setup could not locate both CrowiApiClient lines"
reorder_tmp="${reorder_lines[$comment_idx]}"
reorder_lines[comment_idx]="${reorder_lines[$type_idx]}"
reorder_lines[type_idx]="$reorder_tmp"
printf '%s\n' "${reorder_lines[@]}" >"$REORDER_FILE"
git -C "$REORDER_REPO" add src/export/client-chain.ts
git -C "$REORDER_REPO" commit -qm "reorder distinct CrowiApiClient matching lines"
status="$(run_validator "$REORDER_REPO" "$REORDER_REPO/specs/ready.md" "$OUTPUT")"
assert_status 1 "$status" "reordering distinct matching lines must be a hard stale error"
grep -qi 'client-chain.ts#CrowiApiClient' "$OUTPUT" || fail "AC-9 reorder error must identify path#symbol"

# AC-9 (identical-line reorder, the documented non-guarantee): swapping the
# order of blocks that each *begin* with a byte-identical matching line
# leaves the matching-line sequence unchanged (grep's output is 3 copies of
# the same string either way), so this must warn rather than silently pass
# with no signal at all — it is the real mermaid-spike shape design decision
# 5 names (the same `it(` line repeated across independent test blocks).
REORDER_IDENTICAL_REPO="$TMP_ROOT/reorder-identical-repo"
cp -R "$REPO" "$REORDER_IDENTICAL_REPO"
git -C "$REORDER_IDENTICAL_REPO" reset -q --hard "$BASE_SHA"
IDENTICAL_FILE="$REORDER_IDENTICAL_REPO/src/export/identical-lines.ts"
cat >"$IDENTICAL_FILE" <<'EOF'
it('same test', () => {
  doA();
});

it('same test', () => {
  doB();
});

it('same test', () => {
  doC();
});
EOF
git -C "$REORDER_IDENTICAL_REPO" add src/export/identical-lines.ts
git -C "$REORDER_IDENTICAL_REPO" commit -qm "add identical-matching-line fixture"
IDENTICAL_BASE="$(git -C "$REORDER_IDENTICAL_REPO" rev-parse HEAD)"
# Backticks are literal markdown delimiters; the symbol itself carries a
# literal single quote and paren, which is fine for a fixed-string grep.
# shellcheck disable=SC2016
write_ready_spec "$REORDER_IDENTICAL_REPO/specs/ready.md" "$IDENTICAL_BASE" "src/export/identical-lines.ts" "it('same test'"
cat >"$IDENTICAL_FILE" <<'EOF'
it('same test', () => {
  doC();
});

it('same test', () => {
  doB();
});

it('same test', () => {
  doA();
});
EOF
git -C "$REORDER_IDENTICAL_REPO" add src/export/identical-lines.ts
git -C "$REORDER_IDENTICAL_REPO" commit -qm "reorder blocks with byte-identical matching lines"
status="$(run_validator "$REORDER_IDENTICAL_REPO" "$REORDER_IDENTICAL_REPO/specs/ready.md" "$OUTPUT")"
assert_status 0 "$status" "reordering blocks whose matching line is byte-identical must warn, not hard-stale"
grep -q '^WARN: referenced path changed but grounded symbol lines are identical: src/export/identical-lines.ts' "$OUTPUT" \
  || fail "AC-9 identical-line reorder must emit a WARN"
grep -q '^READY:' "$OUTPUT" || fail "AC-9 identical-line reorder must still emit READY"
grep -q '^ERROR:' "$OUTPUT" && fail "AC-9 identical-line reorder must not emit an ERROR"

# AC-10 (generated freshness regression): a reference path matching the
# generated-artifact pattern is excluded from freshness before any dirty/diff
# check runs at all — changing it after grounded_at must not affect the
# outcome or appear anywhere in the output.
GENERATED_REPO="$TMP_ROOT/generated-repo"
cp -R "$REPO" "$GENERATED_REPO"
git -C "$GENERATED_REPO" reset -q --hard "$BASE_SHA"
mkdir -p "$GENERATED_REPO/src/export/generated"
printf 'export const schema = 1;\n' >"$GENERATED_REPO/src/export/generated/schema.ts"
git -C "$GENERATED_REPO" add src/export/generated/schema.ts
git -C "$GENERATED_REPO" commit -qm "add a generated-looking artifact"
GENERATED_BASE="$(git -C "$GENERATED_REPO" rev-parse HEAD)"
GENERATED_SPEC="$GENERATED_REPO/specs/ready.md"
write_ready_spec "$GENERATED_SPEC" "$GENERATED_BASE" "src/export/export.ts"
# Backticks are literal markdown delimiters; `|` is the sed delimiter since
# the search text contains a literal `#`.
# shellcheck disable=SC2016
sed -i.bak 's|- reuse: `src/export/cursor.ts#iterateCursor`|- reuse: `src/export/generated/schema.ts`|' "$GENERATED_SPEC"
printf 'export const schema = 2;\n' >"$GENERATED_REPO/src/export/generated/schema.ts"
git -C "$GENERATED_REPO" add src/export/generated/schema.ts
git -C "$GENERATED_REPO" commit -qm "regenerate the generated artifact"
status="$(run_validator "$GENERATED_REPO" "$GENERATED_SPEC" "$OUTPUT")"
assert_status 0 "$status" "a changed generated-artifact reference must not affect freshness"
grep -q '^READY:' "$OUTPUT" || fail "generated-artifact regression must still emit READY"
grep -qi 'generated/schema.ts' "$OUTPUT" && fail "a generated-artifact reference must never appear in staleness output"

echo "PASS: validate-implementation-spec"
