#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/../e2e-gate.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_status() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$actual" -ne "$expected" ]]; then
    fail "$message (expected status $expected, got $actual)"
  fi
}

# stdout/stderr は別ファイルに分けて捕まえる。AC-7 は「判定と理由が標準出力に
# 出る」ことの契約なので、2>&1 でまとめてしまうと判定が丸ごと stderr に漏れて
# も気付けない (レビュー指摘: judgment/reason が stderr に移動しても素通りして
# しまう) — stdout_file だけを判定の grep 対象にする。
run_gate() {
  local repo="$1" diff_arg="$2" stdout_file="$3" stderr_file="$4" status

  set +e
  (
    cd "$repo"
    "$GATE" "$diff_arg"
  ) >"$stdout_file" 2>"$stderr_file"
  status=$?
  set -e
  printf '%s' "$status"
}

[[ -x "$GATE" ]] || fail "e2e-gate.sh is missing or not executable: $GATE"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO="$TMP_ROOT/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email "e2e-gate-test@example.com"
git -C "$REPO" config user.name "E2E Gate Test"
git -C "$REPO" config commit.gpgsign false
mkdir -p "$REPO/packages/api-contract/src" "$REPO/packages/e2e/tests" "$REPO/docs" "$REPO/.claude/skills" "$REPO/apps/crowi-site/content"
printf '# crowi\n' >"$REPO/README.md"
printf 'export const x = 1;\n' >"$REPO/packages/api-contract/src/index.ts"
printf 'export const y = 1;\n' >"$REPO/packages/e2e/tests/existing.spec.ts"
printf '# doc\n' >"$REPO/docs/existing.md"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "initial"
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"

OUTPUT="$TMP_ROOT/output"
ERR_OUTPUT="$TMP_ROOT/output.err"

# AC-1: allow-list 内のみの変更は skip。
ALLOW_REPO="$TMP_ROOT/allow-repo"
cp -R "$REPO" "$ALLOW_REPO"
printf '# updated\n' >>"$ALLOW_REPO/docs/existing.md"
printf 'note\n' >"$ALLOW_REPO/.reviews-note.md" # top-level *.md (nested dir intentionally avoided)
mkdir -p "$ALLOW_REPO/.feature-state/tasks" "$ALLOW_REPO/.reviews" "$ALLOW_REPO/apps/crowi-site/content"
printf '{}\n' >"$ALLOW_REPO/.feature-state/tasks/scratch.json"
printf 'note\n' >"$ALLOW_REPO/.reviews/scratch.md"
printf 'skill body\n' >"$ALLOW_REPO/.claude/skills/scratch.md"
printf 'mdx body\n' >"$ALLOW_REPO/apps/crowi-site/content/new.mdx"
git -C "$ALLOW_REPO" add -A
git -C "$ALLOW_REPO" commit -qm "allow-list only change"
status="$(run_gate "$ALLOW_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "allow-list-only change must exit 0"
grep -q '^SKIP:' "$OUTPUT" || fail "AC-1: allow-list-only change must SKIP: $(cat "$OUTPUT")"
grep -q '^RUN:' "$OUTPUT" && fail "AC-1: allow-list-only change must not RUN"

# AC-2: packages/api-contract/** だけの変更は run。
CONTRACT_REPO="$TMP_ROOT/contract-repo"
cp -R "$REPO" "$CONTRACT_REPO"
printf 'export const x = 2;\n' >"$CONTRACT_REPO/packages/api-contract/src/index.ts"
git -C "$CONTRACT_REPO" add -A
git -C "$CONTRACT_REPO" commit -qm "contract change"
status="$(run_gate "$CONTRACT_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "api-contract-only change must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "AC-2: api-contract-only change must RUN: $(cat "$OUTPUT")"
grep -q 'packages/api-contract/src/index.ts' "$OUTPUT" || fail "AC-2: RUN reason must name the api-contract path"

# AC-3: packages/e2e/** だけの変更は run。
E2E_REPO="$TMP_ROOT/e2e-repo"
cp -R "$REPO" "$E2E_REPO"
printf 'export const y = 2;\n' >"$E2E_REPO/packages/e2e/tests/existing.spec.ts"
git -C "$E2E_REPO" add -A
git -C "$E2E_REPO" commit -qm "e2e change"
status="$(run_gate "$E2E_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "e2e-only change must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "AC-3: e2e-only change must RUN: $(cat "$OUTPUT")"
grep -q 'packages/e2e/tests/existing.spec.ts' "$OUTPUT" || fail "AC-3: RUN reason must name the e2e path"

# AC-4: allow-list 内と外が混ざった変更は run。
MIXED_REPO="$TMP_ROOT/mixed-repo"
cp -R "$REPO" "$MIXED_REPO"
printf '# updated\n' >>"$MIXED_REPO/docs/existing.md"
printf 'export const x = 2;\n' >"$MIXED_REPO/packages/api-contract/src/index.ts"
git -C "$MIXED_REPO" add -A
git -C "$MIXED_REPO" commit -qm "mixed change"
status="$(run_gate "$MIXED_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "mixed change must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "AC-4: mixed change must RUN: $(cat "$OUTPUT")"
grep -q 'packages/api-contract/src/index.ts' "$OUTPUT" || fail "AC-4: RUN reason must name the outside path"

# AC-4 regression: git のリネーム自動検出が移動元パスを隠してはならない。
# `git diff --name-only` (--no-renames 無し) はリネームを移動先 1 パスに
# 畳んでしまうため、allow-list 外のパスから allow-list 内へリネームした変更が
# 見かけ上 allow-list 内のみに見えて SKIP してしまう欠陥があった。
RENAME_REPO="$TMP_ROOT/rename-repo"
cp -R "$REPO" "$RENAME_REPO"
printf 'to be renamed\n' >"$RENAME_REPO/packages/api-contract/src/renameme.md"
git -C "$RENAME_REPO" add -A
git -C "$RENAME_REPO" commit -qm "add file that will be renamed"
RENAME_BASE_SHA="$(git -C "$RENAME_REPO" rev-parse HEAD)"
git -C "$RENAME_REPO" mv packages/api-contract/src/renameme.md docs/renamed.md
git -C "$RENAME_REPO" commit -qm "rename an outside-allow-list file into the allow-list"
status="$(run_gate "$RENAME_REPO" "$RENAME_BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "rename-outside-into-allow-list change must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "AC-4 regression: renaming an outside-allow-list path into the allow-list must still RUN: $(cat "$OUTPUT")"
grep -q 'packages/api-contract/src/renameme.md' "$OUTPUT" || fail "AC-4 regression: RUN reason must name the pre-rename outside path, not just the destination: $(cat "$OUTPUT")"

# AC-5: allow-list に無い新規 package を追加した変更は run。
NEW_PKG_REPO="$TMP_ROOT/new-pkg-repo"
cp -R "$REPO" "$NEW_PKG_REPO"
mkdir -p "$NEW_PKG_REPO/packages/brand-new-thing/src"
printf 'export const z = 1;\n' >"$NEW_PKG_REPO/packages/brand-new-thing/src/index.ts"
git -C "$NEW_PKG_REPO" add -A
git -C "$NEW_PKG_REPO" commit -qm "new unknown package"
status="$(run_gate "$NEW_PKG_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "unknown new package must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "AC-5: unknown new package must RUN: $(cat "$OUTPUT")"
grep -q 'packages/brand-new-thing/src/index.ts' "$OUTPUT" || fail "AC-5: RUN reason must name the new package path"

# AC-6: range が解決できない場合は run (script は exit 0 のまま判定を返す —
# ヘルパーの失敗が skip を意味してはならない契約)。
status="$(run_gate "$REPO" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "unresolvable range must still exit 0 with a decision"
grep -q '^RUN:' "$OUTPUT" || fail "AC-6: unresolvable range must RUN: $(cat "$OUTPUT")"

# AC-6b: git worktree の外で呼ばれた場合も run に倒れる。
NON_REPO="$TMP_ROOT/not-a-repo"
mkdir -p "$NON_REPO"
status="$(run_gate "$NON_REPO" "main..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "call outside a git worktree must still exit 0 with a decision"
grep -q '^RUN:' "$OUTPUT" || fail "AC-6b: call outside a git worktree must RUN: $(cat "$OUTPUT")"

# AC-7: 判定と理由が標準出力に出る (RUN 側 — 5件超で "+N more" に切り詰められる
# ことも合わせて確認)。stdout/stderr を分けて捕まえているので、判定行が誤って
# stderr に出ていればここで検出できる。
MANY_REPO="$TMP_ROOT/many-repo"
cp -R "$REPO" "$MANY_REPO"
mkdir -p "$MANY_REPO/packages/many/src"
for i in 1 2 3 4 5 6 7; do
  printf 'export const v%d = %d;\n' "$i" "$i" >"$MANY_REPO/packages/many/src/file-$i.ts"
done
git -C "$MANY_REPO" add -A
git -C "$MANY_REPO" commit -qm "many outside paths"
status="$(run_gate "$MANY_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "many-outside-paths change must exit 0"
grep -q '^RUN: changed paths outside the e2e-safe allow-list:' "$OUTPUT" || fail "AC-7: RUN line must state the reason on stdout: $(cat "$OUTPUT"); stderr was: $(cat "$ERR_OUTPUT")"
grep -q '(+2 more)' "$OUTPUT" || fail "AC-7: RUN reason must truncate to the first 5 paths and count the remainder: $(cat "$OUTPUT")"

# AC-7b: skip 側の理由も stdout に出力される。
status="$(run_gate "$ALLOW_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "allow-list-only change must exit 0 (rerun)"
grep -q '^SKIP: all changed paths in' "$OUTPUT" || fail "AC-7b: SKIP line must state the reason on stdout: $(cat "$OUTPUT"); stderr was: $(cat "$ERR_OUTPUT")"

# AC-7 regression: 非 ASCII パスは core.quotePath=true (git の既定値) でも
# クォートされた文字列として誤分類されてはならない。-z 出力を使わない実装
# だと "docs/日本語.md" が `"docs/\346..."` のような quoted literal になり、
# allow-list の正規表現にマッチせず誤って RUN してしまう欠陥があった。
QUOTEPATH_REPO="$TMP_ROOT/quotepath-repo"
cp -R "$REPO" "$QUOTEPATH_REPO"
git -C "$QUOTEPATH_REPO" config core.quotePath true
printf 'first\n' >"$QUOTEPATH_REPO/docs/日本語.md"
git -C "$QUOTEPATH_REPO" add -A
git -C "$QUOTEPATH_REPO" commit -qm "add non-ascii allow-listed file"
QUOTEPATH_BASE_SHA="$(git -C "$QUOTEPATH_REPO" rev-parse HEAD)"
printf 'first\nsecond\n' >"$QUOTEPATH_REPO/docs/日本語.md"
git -C "$QUOTEPATH_REPO" add -A
git -C "$QUOTEPATH_REPO" commit -qm "update non-ascii allow-listed file"
status="$(run_gate "$QUOTEPATH_REPO" "$QUOTEPATH_BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "non-ascii allow-listed change must exit 0"
grep -q '^SKIP:' "$OUTPUT" || fail "AC-1/AC-7 regression: a non-ascii allow-listed path under core.quotePath=true must still SKIP: $(cat "$OUTPUT")"

# AC-7 regression: 改行を含む合法な Git ファイル名でも判定行は 1 行のまま。
# -z 出力は NUL 以外のバイトをそのまま通すため、埋め込み改行を持つパスがある
# と JOINED にも生の改行が混じり、"stdout に必ず1行" の契約が崩れる欠陥が
# あった (printf '%q' での表示前サニタイズで解消)。
NEWLINE_REPO="$TMP_ROOT/newline-repo"
cp -R "$REPO" "$NEWLINE_REPO"
mkdir -p "$NEWLINE_REPO/packages/weird"
NEWLINE_PATH=$'packages/weird/multi\nline.ts'
: >"$NEWLINE_REPO/$NEWLINE_PATH"
git -C "$NEWLINE_REPO" add -A
git -C "$NEWLINE_REPO" commit -qm "add a file whose name contains a newline"
status="$(run_gate "$NEWLINE_REPO" "$BASE_SHA..HEAD" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "newline-in-filename change must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "AC-7 regression: newline-in-filename change must RUN: $(cat "$OUTPUT")"
[[ "$(wc -l <"$OUTPUT")" -eq 1 ]] || fail "AC-7 regression: reason line must stay on a single stdout line even when a changed path's name contains a newline: $(cat "$OUTPUT")"

# integrate-worktree Step 4 は no-commit merge 中に呼ぶため main..HEAD が常に
# 空になる (HEAD がまだ main のまま) — 代わりに staged diff (--cached) を渡す。
# ここでは "git diff --name-only --cached --" がそのまま通ることだけを確認する。
CACHED_REPO="$TMP_ROOT/cached-repo"
cp -R "$REPO" "$CACHED_REPO"
printf 'export const x = 3;\n' >"$CACHED_REPO/packages/api-contract/src/index.ts"
git -C "$CACHED_REPO" add packages/api-contract/src/index.ts
status="$(run_gate "$CACHED_REPO" "--cached" "$OUTPUT" "$ERR_OUTPUT")"
assert_status 0 "$status" "--cached diff arg must exit 0"
grep -q '^RUN:' "$OUTPUT" || fail "--cached with an outside-allow-list staged path must RUN: $(cat "$OUTPUT")"

# usage エラー: 引数が無ければ exit 2。
set +e
(
  cd "$REPO"
  "$GATE"
) >"$OUTPUT" 2>"$ERR_OUTPUT"
usage_status=$?
set -e
assert_status 2 "$usage_status" "missing diff arg must be a usage error"

echo "PASS: e2e-gate"
