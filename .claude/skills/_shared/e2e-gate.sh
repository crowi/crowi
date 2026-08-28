#!/usr/bin/env bash
# e2e-gate.sh <git-diff-arg>
#
# 単一の判定: e2e を回すかどうかの判断はこのファイルにのみ存在する。呼び出し側
# (crowi-complete-feature のゲート9 / integrate-worktree の Step 4) はこの判定を
# 再実装せず、必ずこのヘルパーを呼ぶ。
#
# <git-diff-arg> はそのまま `git diff --name-only -z --no-renames <git-diff-arg> --` に渡す。
# 典型的な形:
#   main..HEAD   — 通常の統合先レンジ (crowi-complete-feature)
#   --cached     — no-commit merge 中の staged diff (integrate-worktree Step 4。
#                  Step 3.3 の注記どおり、この時点では HEAD がまだ main を指した
#                  ままなので "main..HEAD" は常に空になり使えない)
#
# stdout に必ず 1 行、判定と理由を出す:
#   RUN: <理由>    — e2e を実行する
#   SKIP: <理由>   — e2e を省略してよい
#
# 契約 (呼び出し側はこの形を壊さないこと):
#   - skip してよいのは、変更パスが「すべて」下記 allow-list に収まるときだけ。
#     1 つでも外にあれば run。allow-list はこのファイルに 1 箇所だけ持つ。
#   - 判定不能 (git range が解決できない、worktree の外で呼ばれた等) は run に
#     倒す。ヘルパーが理由行を出せなかった (クラッシュ・空出力) 場合も、呼び出し
#     側は skip とみなしてはならない — "SKIP:" で始まる行を得られたときだけ
#     skip、それ以外はすべて run として扱うこと。
#   - allow-list が不完全なときに起きるのは「不要に run」だけで、「誤って skip」
#     する経路は構造的に存在しない。これが本ヘルパーの向きそのもの。
#
# exit 0: 判定を出力できた (RUN/SKIP どちらでも — 判定不能で RUN になった場合も
#         含めて、これは正常終了)。
# exit 2: usage エラー (引数の過不足)。

set -u

usage() {
  echo "usage: e2e-gate.sh <git-diff-arg>  (e.g. 'main..HEAD' or '--cached')" >&2
  exit 2
}

[[ "$#" -eq 1 ]] || usage
DIFF_ARG="$1"

# allow-list はここに 1 箇所だけ持つ。ここに無いパスは新規 package も含めて
# すべて run 側に倒れる — 「e2e に影響しないことが明らかなときだけ skip」という
# 向きを守るための唯一のリスト。
ALLOWLIST_PATTERNS=(
  '^apps/crowi-site/'
  '^\.claude/'
  '^\.reviews/'
  '^\.feature-state/'
  '^docs/'
  '^[^/]+\.md$' # リポジトリ直下の *.md のみ (ネストした *.md は対象外)
)

path_in_allowlist() {
  local path="$1" pattern
  for pattern in "${ALLOWLIST_PATTERNS[@]}"; do
    [[ "$path" =~ $pattern ]] && return 0
  done
  return 1
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "RUN: not inside a git worktree; unable to resolve diff arg '$DIFF_ARG'"
  exit 0
fi

# -z: NUL-delimited, unquoted output — without it, a path with non-ASCII
# characters is C-style-quoted whenever core.quotePath is on (the git
# default), so "docs/日本語.md" would be emitted as a literal quoted string
# and misclassified as outside the allow-list.
# --no-renames: a plain `git diff --name-only` auto-detects renames and
# collapses a rename into just the destination path, silently hiding the
# source. A rename from an allow-list-external path into the allow-list
# would then read as SKIP even though the original path was never covered.
# A temp file (not a `$(...)` string) holds the output because bash strings
# cannot carry embedded NUL bytes — capturing NUL-delimited data via command
# substitution would silently truncate at the first NUL.
DIFF_OUT="$(mktemp)"
trap 'rm -f "$DIFF_OUT"' EXIT
git diff --name-only -z --no-renames "$DIFF_ARG" -- >"$DIFF_OUT" 2>/dev/null
DIFF_STATUS=$?
if [[ "$DIFF_STATUS" -ne 0 ]]; then
  echo "RUN: unable to resolve git diff arg '$DIFF_ARG' (git diff exited $DIFF_STATUS); failing open"
  exit 0
fi

if [[ ! -s "$DIFF_OUT" ]]; then
  echo "SKIP: '$DIFF_ARG' has no changed paths"
  exit 0
fi

OUTSIDE_PATHS=()
while IFS= read -r -d '' path; do
  [[ -z "$path" ]] && continue
  path_in_allowlist "$path" || OUTSIDE_PATHS+=("$path")
done <"$DIFF_OUT"

if [[ "${#OUTSIDE_PATHS[@]}" -eq 0 ]]; then
  echo "SKIP: all changed paths in '$DIFF_ARG' are within the e2e-safe allow-list (apps/crowi-site/**, .claude/**, .reviews/**, .feature-state/**, docs/**, top-level *.md)"
  exit 0
fi

# -z で読んだパスは NUL 以外のバイトをそのまま保持するため、改行を含むファイル
# 名 (git 上は合法) がそのまま混じりうる。理由行は「標準出力に必ず1行」が
# 契約 (AC-7) なので、表示直前に printf '%q' で shell-quote する — 通常の
# ASCII パス (英数字・/・.・-・_ のみ) は無変換のまま出力され、改行や制御文字を
# 含むパスだけが `$'...\n...'` の 1 行表現にエスケープされる。
sanitize_path_for_display() {
  printf '%q' "$1"
}

# 理由には先頭のいくつかだけを見せる (全件を出すと未知の大量差分で判定行が
# 読みにくくなる — run/skip の判断自体には影響しない、あくまで人が読む理由)。
SHOWN=("${OUTSIDE_PATHS[@]:0:5}")
JOINED=""
for shown_path in "${SHOWN[@]}"; do
  shown_path="$(sanitize_path_for_display "$shown_path")"
  # "${SHOWN[*]}" 展開は IFS の先頭 1 文字だけを区切りに使うため ", " のような
  # 2 文字区切りは作れない (comma だけになる) — ループで組み立てる。
  if [[ -z "$JOINED" ]]; then
    JOINED="$shown_path"
  else
    JOINED="$JOINED, $shown_path"
  fi
done
REMAINING=$((${#OUTSIDE_PATHS[@]} - ${#SHOWN[@]}))
if [[ "$REMAINING" -gt 0 ]]; then
  echo "RUN: changed paths outside the e2e-safe allow-list: $JOINED (+$REMAINING more)"
else
  echo "RUN: changed paths outside the e2e-safe allow-list: $JOINED"
fi
exit 0
