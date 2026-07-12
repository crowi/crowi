---
name: crowi-pr-received
description: |
  外部から GitHub PR が来たときの triage → 分類 → 対応判断 → (承認後の)応答/取り込みを
  定型化する skill。他人のコードは checkout もスクリプト実行もせず gh 経由の remote diff
  だけで triage を完結させ、merge / close / comment などの外向き操作は必ず sotarok の
  承認を経る。supply chain 攻撃(lockfile poisoning / postinstall / workflow 改変)の
  予防を最優先に置く。
  キーワード: PR, pull request, 外部コントリビュート, triage, スパム, supply chain, i18n, 翻訳
---

# Crowi PR Received (外部 PR の triage と対応)

v2 は sotarok の main 直コミット中心で開発しており、外部 PR は例外イベント。来たときの
対応を場当たりにしないための手順。**公開ポリシーの正本は `CONTRIBUTING.md`**(外向き) —
この skill はその maintainer 側の実行手順(内向き)で、両者は整合させて保守する。

## 起動例

```
/crowi-pr-received 914
/crowi-pr-received 914 --integrate   # 取り込み決定済みの PR の Phase 4 だけ実行
```

## 鉄則(すべての分類に先立つ)

1. **PR をそのまま merge しない**。取り込む場合も必ず Phase 4 の隔離経路を通す。
2. **full diff レビュー完了までは一切のスクリプト実行禁止**。`pnpm install` だけでなく
   `pnpm test` / `build` / `dev` もリポジトリ内コードを実行する(jest/turbo/biome の
   config、postinstall 等、実行面は install に限らない)。triage は gh の remote read
   だけで完結させ、**checkout しない**。
3. **`pnpm-lock.yaml` を触る PR は内容が何であれ最大警戒**(lockfile poisoning:
   package.json が無害でも lockfile の resolved URL を悪性 tarball に差し替える定番手口)。
4. **`.github/workflows/` の変更はカテゴリ問わず取り込まない**(secrets 窃取の王道経路)。
   workflow 変更が必要な提案は内容だけ参考にし、自前で書く。
5. **merge / close / comment / label 等の外向き操作は必ず sotarok の承認後**。この skill
   が自動で行うのは読み取りとドラフト作成まで。
6. どの分類でも **1 週間以内に何か返す**(放置が最も評判を損なう)。

## Phase 1: triage(checkout なし・gh のみ)

```bash
gh pr view <n> --json title,author,createdAt,additions,deletions,changedFiles,body
gh pr view <n> --json files --jq '.files[].path'
gh pr diff <n>            # remote diff を読む。これが triage の唯一の情報源
# 作者の横断活動(spam シグナルの客観判定)
gh api 'search/issues?q=author:<login>+type:pr&sort=created&order=desc&per_page=10' \
  --jq '.items[] | "\(.created_at | .[0:10])  \(.repository_url | sub(".*repos/"; ""))  \(.title)"'
```

spam シグナル: 同一タイトル PR の複数リポジトリ横断撒布 / 事前 issue・相談なし /
アカウントの活動が撒布 PR のみ。1 つでも該当したら分類判断に反映(即 spam 断定ではない)。

**分類**(複合する場合は最も厳しい方を適用):

| 分類 | 判定基準 |
|---|---|
| spam | 横断撒布・実体のない変更・contributor 実績稼ぎ |
| deps / lockfile | package.json / pnpm-lock.yaml / .npmrc の bump・変更 |
| workflows | `.github/workflows/` を含む |
| docs / typo | ドキュメント・コメントのみ |
| i18n(新 locale) | 新しい言語の追加(訳文更新は docs 寄りで判断) |
| bugfix | 既存挙動の修正を主張 |
| feature | 新機能・挙動追加 |
| security | 脆弱性修正を主張(または明らかにそれに触れる) |

## Phase 2: 分類別チェックリスト

### spam
- 対応: close(丁寧に・理由明記)。議論しない。テンプレ「close-spam」。

### deps / lockfile
- 対応: 原則 close。依存管理は内部判断で行う(テンプレ「close-deps」)。
- lockfile を触っていたら diff の resolved / integrity 差分を必ず目視(取り込まない場合でも
  攻撃かどうかは把握しておく — 攻撃なら GitHub に報告)。

### workflows
- workflow 部分は絶対に取り込まない(鉄則 4)。それ以外の部分に価値があれば該当分類で
  再評価し、「workflow 変更は受けられない」旨を応答に含める。

### docs / typo
- 本物で安価なら取り込み候補(Phase 4 へ)。spam シグナルありなら close。

### i18n(新 locale)
- 新 locale は差分の受け入れではなく**恒久的な製品コミットメント**(以後すべての新規
  文字列でその locale が腐っていく + 品質を maintainer が検証できない)。
- 受け入れ条件: **実ユーザー需要の証拠 + その locale の継続メンテ意思**の 2 点。
- 既定の対応: **conditional accept** — テンプレ「conditional-accept-locale」で
  「実際に Crowi を使っているか / locale を継続メンテする意思があるか」を問う。
  **約 2 週間**無反応なら丁寧に close(需要とメンテナが揃えば歓迎、と扉は開けておく)。

### bugfix
1. **不具合の実在をコードから裏取り**する(PR の主張を鵜呑みにしない。再現条件・
   根本原因を該当コードで確認)。
2. 実在し、かつ当該変更が**本質的な解決**か判定(症状の隠蔽・場当たりなら不採用)。
3. 妥当 → Phase 4 で取り込み。妥当でない/別解が正しい → 参考として受け取り close、
   必要なら spec 化して自前修正(その場合の authorship 規律は Phase 4 参照)。

### feature
1. **その機能が Crowi に必要かは sotarok の製品判断** — 判断材料(何を解決するか・
   誰の需要か・保守コスト)を整理して提示し、判断を仰ぐ。勝手に進めない。
2. 必要と判断されたら、**その実装手段が Crowi にとって良いか**を検討。
   - 良い → ある程度参考にしつつ取り込み方を設計(Phase 4)。
   - 悪い → 機能要望として記録し close(テンプレ「close-feature」。要望自体への感謝を明記)。

### security
- 公開 PR での脆弱性修正は**公開開示**になっている。private 報告(`SECURITY.md` /
  GitHub Security Advisories)へ誘導し、PR は close。修正は自前で行い、報告者に
  クレジットを付与する。
- 「セキュリティ修正」を装って backdoor を仕込む手口も既知 — security を名乗る PR ほど
  diff を厳しく読む。

## Phase 3: 推奨 + 応答ドラフト → 承認ゲート

分類・チェック結果・推奨(merge 経路 / conditional accept / close)・**応答文ドラフト
(英語)**をまとめて提示し、sotarok の承認を待つ。承認後に `gh pr comment` /
`gh pr close` 等を実行する。文面テンプレは `templates.md`(この skill ディレクトリ)を
ベースに、PR の具体に合わせて調整する。

## Phase 4: 取り込み経路(取り込み決定後のみ)

1. `git fetch origin pull/<n>/head:pr-<n>`(fetch のみ。この時点でも checkout しない)。
2. full diff を再確認(`git diff main...pr-<n>`)。lockfile / workflows / config 類の
   変更が紛れていないか最終チェック。
3. 実行が必要な検証は **gw worktree に隔離**して行う(main worktree では実行しない):
   - 初回 install は `pnpm install --ignore-scripts` から。scripts 実行が必要になったら
     その必要性を diff で確認してから通常 install。
   - **実 `.env` を渡さない**。QA が要る場合は per-run 隔離 DB 機構(crowi-qa §6.4 の
     QA 専有インスタンス)を使い、共有 dev の秘密・データに触れさせない。
4. 通常の統合品質ゲート(type-check / test / lint、contract 変更なら check:openapi)を通す。
5. **authorship 規律**:
   - 相手のコードを実質そのまま使う → PR を通常 merge するか、cherry-pick で
     author を保持する(コードの出所を消さない)。
   - 参考にしつつ自前で書き直す → close 時に thanks + 参考にした旨を明記し、
     commit message でも PR 番号に言及する。
   - 「close してコードだけ使う」形に見える取り込みは絶対にしない。
6. merge / push は従来どおり sotarok の指示を待つ。

## CONTRIBUTING.md との関係

外部向けの期待値(feature は issue 先行 / deps bump は受けない / 新 locale の条件 /
security は private 報告)は `CONTRIBUTING.md` が正本。この skill の分類・条件を変える
ときは CONTRIBUTING.md も同じ commit で更新する(ドリフトさせない)。
