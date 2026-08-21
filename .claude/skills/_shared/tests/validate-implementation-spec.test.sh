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

write_ready_spec() {
  local path="$1"
  local grounded_at="$2"
  local change_path="$3"

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
- symbols: \`exportRows\`
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

echo "PASS: validate-implementation-spec"
