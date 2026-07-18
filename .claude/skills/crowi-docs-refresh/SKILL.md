---
name: crowi-docs-refresh
description: |
  直近の main の変更(integrate 済み feature・fix)を踏まえて apps/crowi-site/ の
  ドキュメント(content/docs/{ja,en})を更新し、既存ページに陳腐化した記述が
  ないかを実コード照合で調査・修正する定期メンテ skill。integrate が数本たまった
  とき・release pre-flight の前・「ドキュメント古くない?」と言われたときに回す。
  キーワード: docs, ドキュメント, 陳腐化, stale, 古い, site, crowi-site, mdx,
  ja/en, ドキュメント更新, docs-refresh, doc rot
---

# Crowi Docs Refresh (site ドキュメントの追随 + 陳腐化掃除)

> 標準の呼び出し元: 手動の `/crowi-docs-refresh` に加えて、**integrate-worktree の
> Step 10** が統合完了時の drain point(他に READY_TO_INTEGRATE が残っていない時)に
> 自動で呼ぶ。どちらの経路でも本 skill の動作は同一(watermark 駆動)。

`apps/crowi-site/`(crowi.wiki の LP + docs・Fumadocs)を main の実装に追随させる。
2 つの仕事を 1 回で行う: **①未文書化の user-visible 変更を書き足す**(前回実行以降の
delta 駆動)、**②既存ページの陳腐化を実コード照合で見つけて直す**(claim 検証)。
site は push で Cloudflare Pages に deploy されるため、main に merge 済みの機能は
文書化してよい(未 merge・未実装は書かない)。

## 対象 / 非対象

- 対象: `apps/crowi-site/content/docs/{ja,en}/`(guide / plugins / operations /
  reference の 4 section)+ 必要なら LP 側の feature 記述。
- 非対象: wiki(`/crowi/spec/...`)— spec の publish は crowi-design の領分。
  `docs/rfcs/` — RFC は設計文書であり user docs ではない。README 群。

## ワークフロー

### Step 0: scope 解決(1 回だけ確定)

1. 引数に git range(`abc..def`)があればそれ。
2. なければ `.feature-state/docs-sync-state.json` の `lastDocsSyncSha..HEAD`。
3. state が無い初回は self-bootstrap: `git log -1 --format=%H -- apps/crowi-site/content`
   (site docs を最後に触った commit)を起点にする。docs はそこまでは同期して
   いたはず、という近似 — 実行後は state が引き継ぐ。

### Step 1: delta 抽出(何が user-visible に変わったか)

range 内から docs 影響候補を集める:

```bash
# 主信号: user-visible 変更は changeset として積まれている(CLAUDE.md の運用)
git diff --name-only --diff-filter=A <range> -- .changeset | grep -v README
# 副信号: feat/fix commit と merge summary
git log --oneline --no-merges <range> | grep -E "^[0-9a-f]+ (feat|fix)"
git log --merges --format="%h %s%n%b" <range>
```

各候補を仕分ける:
- **docs 済み**: range 内で対応する `content/docs` 変更が既に入っている
  (`git log <range> -- apps/crowi-site/content` と突き合わせ)→ skip。
  feature pipeline は docs 同梱が多いので、これが最頻ケース。
- **docs 必要**: 新しい記法 / config / env / UI 挙動 / 運用手順の変化 → Step 2 へ。
- **docs 不要**: 内部 refactor・test・CI のみ → skip(判断を 1 行残す)。

### モデル割り当て(Codex/Claude の分担 — 2026-07-18 user 合意)

制御・glue・ゲート・commit は Claude(本 session)、分析・批評・長文は Codex。
Codex は必ず `.claude/scripts/codex-run.sh` 経由(exec + strict schema。
`--tier sol|terra|luna` — sol=最難関/terra=標準/luna=軽作業)。再実行前に
stale 成果物を掃除する(codex-runs の invocation 跨ぎ再利用に注意)。

| 仕事 | 担当 |
|---|---|
| scope 解決・delta 抽出・parity/build ゲート・commit | Claude(session) |
| 陳腐化 sweep(docs↔code の敵対照合) | Codex **terra** |
| 難所の挙動解明(cache 意味論・並行・security — 誤記述が実害になる箇所) | Codex **sol**(単発・難所限定) |
| en ページの draft(長文) | Codex **terra** |
| ja ページの draft(既存 docs の文体との一貫性) | Claude |
| 最終照合 | **書き手と逆のモデル**(Claude 執筆分は Codex が事実照合、Codex 執筆分は Claude が照合) |

### Step 2: 書き足し(実コードから書く)

- **commit message や changeset の文面だけから書かない**。該当の実コード
  (handler / plugin / component)と、あればテストの AC を読んでから書く —
  message は意図であり、docs は挙動の記述。spec ファイルは integrate 後に
  消えているのが正常なので、頼らない。挙動が非自明な難所(上表)は先に
  Codex sol へ「file:line 根拠付きで正確な挙動を説明せよ」を単発で投げ、
  その出力を下敷きにする。
- **en は Codex terra に draft させ、ja は Claude が書く**(en の翻訳ではなく
  既存 ja docs の文体で書き直す)。書き上がったら逆モデルで事実照合。
- 置き場所は既存 4 section の構造に従う(新記法 → guide/markdown、plugin →
  plugins/、env・deploy → operations/、API 面 → reference/)。新ページより
  既存ページへの追記を優先。
- **ja / en を同時に書く**。片方だけの commit を作らない。

### Step 3: 陳腐化調査(claim 検証)

2 層で行う。大きい範囲なら層 b は subagent に fan-out してよい:

a. **delta 隣接ページの精読**: Step 1 の変更が触れた領域の既存ページを読み、
   今回の変更で古くなった記述(挙動・制限・既定値)を直す。
b. **機械照合 sweep(Codex terra へ offload)**: 「以下の docs の claim 群を
   実コードに当てて反証せよ」を `codex-run.sh --sandbox read-only --tier terra`
   に exec + strict FINDINGS schema(crowi-review と同形)で投げる。照合先の正:
   - env 変数 → `.env.example` + `packages/api/src/util/env-schema.ts`
   - config キー → `apps/crowi-runner/crowi.config.json` + 各 plugin の config schema
   - 記法・embed tag → renderer 登録(`addEmbedTag` / `addCodeBlockRenderer` 等の呼び出し)
   - コマンド・scripts → 各 `package.json` / `crowi-admin` / `@crowi/cli`
   - ポート・URL → `scripts/dev-ports.mjs` / `Caddyfile`
   findings は Claude が **verification-on-action** で裁く(直すものだけ実コードで
   裏取り)— **fix or drop**(修正するか、誤検出として 1 行報告)。terra の指摘の
   うち確信が持てず裏取りも難しい claim だけ **sol にエスカレーション**して正否を
   確定する(sweep 全体を sol で回すのは過剰)。codex 不可(exit 2)なら Claude
   subagent で代替し、報告に明記。
   なお「docs が正しく code が退行」の可能性が残る claim は直さず報告して
   ユーザー判断(docs 側を勝手に実装へ合わせない)。

### Step 4: ゲート

```bash
# ja/en parity: 変更した docs ページに ja/en の対応があるか(片翼更新の検知)。
# sed は 2 式で書く — BSD sed の BRE は \| 非対応で、1 式のグループ交替だと
# 正常ペアまで PARITY MISS に化ける(実測済み)。
git diff --name-only HEAD -- apps/crowi-site/content \
  | sed -e 's|/docs/ja/|/docs/*/|' -e 's|/docs/en/|/docs/*/|' \
  | sort | uniq -c | awk '$1 == 1 {print "PARITY MISS:", $2}'
pnpm --filter @crowi/site build    # Fumadocs は壊れた mdx / リンクでビルドが落ちる
pnpm --filter @crowi/site lint && pnpm --filter @crowi/site type-check
```

parity 検知は構造が対称なページのみの近似(LP 等の片側限定ファイルは除外して
判断)。build が通らない mdx は commit しない。

### Step 5: commit + watermark

- `docs(site): ...`(英語)。main-direct なら **main write lock を取得**して
  commit 後に解放(CLAUDE.md「main write lock」)。changeset は不要(docs のみ)。
  **push しない**(ユーザー指示待ち)。
- watermark を atomic に更新:

```bash
printf '{ "lastDocsSyncSha": "%s", "at": "%s" }\n' "$(git rev-parse HEAD)" \
  "$(date -u +%FT%TZ)" > .feature-state/docs-sync-state.json.tmp \
  && mv .feature-state/docs-sync-state.json.tmp .feature-state/docs-sync-state.json
```

- 報告: 書き足したページ / 直した stale 記述 / drop した候補(各 1 行)。

## 鉄則

- **実コードを読まずに docs を書かない**(commit message は意図、docs は挙動)。
- **main に merge されていないものを書かない**(worktree 進行中の機能は次回)。
- **ja / en の片翼更新をしない**。
- 見つけた stale は **fix or drop** — TODO / backlog への退避禁止(全 skill 共通)。
- **push しない**。site の deploy は push に紐づくので、公開タイミングはユーザーが握る。

## エッジケース

| ケース | 挙動 |
|---|---|
| range 内の docs 影響変更がゼロ | 陳腐化 sweep(Step 3b)だけ回して watermark を進める |
| docs が正しく code が退行して見える | docs を触らず報告(修正は crowi-fix の領分) |
| 大型 feature で docs が丸ごと新章になる規模 | 本 skill で書かず、planner への docs spec 依頼を提案(1 ページ超の新章は設計判断を含む) |
| `pnpm --filter @crowi/site build` が既存ページ起因で落ちる | 自分の変更と切り分け、既存起因なら別 fix として報告(黙って直してよいのは自明な壊れリンク程度) |
