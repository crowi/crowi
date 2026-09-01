---
name: crowi-deps
description: |
  Crowi の security 依存(GitHub Dependabot alerts)を本質的に対応する skill。
  「最近 dependency 見てないな」というとき単発 (`/crowi-deps`) で手起動する。
  alert 取得 → direct/transitive 分類 → 根本対応(direct は version bump、
  transitive は親 bump、親が上げられないときだけ per-major override、major upgrade
  待ちは報告のみ)→ pnpm install + lint/type-check/test で検証 → commit
  (push しない)。crowi-orchestrate の D 系統(watcher)も fix の本体としてここを使う。
  キーワード: dependency, dependabot, security, vulnerability, CVE, GHSA, bump,
  override, undici, nodemailer, npm audit, 脆弱性, 依存更新, セキュリティ
---

# Crowi Deps (security 依存の本質的対応)

GitHub Dependabot の open security alert を **根本原因で潰す** skill。crowi-orchestrate
の D 系統が「新規 advisory の検知 + 報告」だけを担うのに対し、この skill は **実際に
直す**(version bump / parent bump / override / major 待ちの報告)+ **検証** + **commit** まで。

単発起動の想定: 「最近 dependency 見てないな」というとき `/crowi-deps` を打つ。
crowi-orchestrate の D 系統からも fix の本体としてこの skill を参照する。

## 鉄則

- **bump を最優先・override は最終手段**。direct dep は宣言版を上げる。transitive は
  親を上げて patched 版を引けるなら親を bump(= version up)。**親が上げられない
  genuinely transitive のときだけ** `pnpm.overrides` で patched に固定する(override は
  ad-hoc ではなく「直接 bump 経路が無い transitive」専用の正規手段。理由を残す)。
- **場当たり的でなく本質的**に。advisory / changelog を読み、なぜその版で直るかを
  確認してから上げる。
- **major upgrade を要するものは強行しない**。判断系なので**報告に残すだけ**にして、
  着手が決まったら `.feature-state/specs/` に spec を切る(退避先のファイルは無い —
  残件は `pnpm outdated` と Dependabot がいつでも再導出する)。high/critical が
  major 待ちで滞留するなら ping。
- **push しない**(commit まで。push は user 指示待ち)。
- **検証して通してから commit**(lint errors=0 / type-check / 影響パッケージの test)。

## 手順

### 0. 既存 override の棚卸し(bump で不要になった override を剥がす)

`pnpm.overrides` は追加され続ける一方で、後から親パッケージ自身が自然に patched 版を
引くようになっても自動では外れない(override が残り続けると、なぜ入れたか分からない
エントリが積み重なる)。**新規 alert の処理を始める前に**、root `package.json` の
`pnpm.overrides` に列挙された各エントリ(`"<pkg>@<range>": "<version>"`)が今も
必要か、1 件ずつ機械的に確認する:

```bash
# 各エントリについて 1 件ずつ:
# 1. そのエントリだけ一時的に削除(他のエントリは触らない)
# 2. pnpm install
# 3. pnpm why -r <pkg> で解決結果を確認
#    — 全ての解決版が override の <version> 以上のままなら、親側が override なしでも
#      既に patched 版を引くようになっている = override は不要 → 削除を確定
#    — 1 つでも <version> 未満に戻るなら、override はまだ必須 → 元に戻す
```

- **1 エントリずつ確認する**(まとめて全部外して確認すると、どれが不要でどれが必須か
  切り分けられない)。
- 不要と確定したものは削除し、commit メッセージに「override `<pkg>` を削除(親
  `<parent>` が override なしで `<version>` 以上を解決するようになったため)」と
  1 行残す。
- 全件確認しても不要なものが無ければ「棚卸し: 変更なし(全 override 継続要)」と
  報告するだけでよい(commit 不要)。
- この棚卸しは新規 alert が 0 件のときも独立して価値がある(`/crowi-deps` を alert
  無しで単発起動しても棚卸しだけは走らせてよい)。

### 1. 取得

```bash
gh api repos/crowi/crowi/dependabot/alerts --paginate -X GET -f state=open \
  --jq '.[] | "\(.number)\t\(.security_advisory.severity)\t\(.dependency.package.name)\t\(.dependency.scope)\tpatched:\(.security_vulnerability.first_patched_version.identifier // "none")"' \
  | sort -t$'\t' -k3,3 -k2,2
```

`gh` が無い / 未認証なら skip(「gh 未認証で skip」とだけ報告)。

### 2. 分類(package ごと)

- **direct か transitive か**: `grep -rlE '"<pkg>"' packages/*/package.json apps/*/package.json package.json`(見つかれば direct、その package と dep/devDep の別も見る)。
- **transitive の親 + 引いている版**: `pnpm why -r <pkg>`。
- **patched 版**: alert の `first_patched_version`。
- severity / scope(runtime / development)。

### 3. 対応の選択(本質的な順)

| ケース | 対応 |
| --- | --- |
| **direct dep + patch あり** | 宣言している package.json の版を patched 以上へ bump |
| **transitive・親を上げれば patched を引ける** | **親 dep を bump**(version up) |
| **transitive・親が上げられない** | `pnpm.overrides` で **per-major** に patched 固定。理由を commit に残す |
| **patched が major upgrade を要する**(例: eslint 8→9 chain の js-yaml、mongoose 8→9 chain の ip-address) | **報告に残すだけ**(強行しない)。着手するなら spec を切る |

> **override の書き方**: root `package.json` の `pnpm.overrides`(または
> `pnpm-workspace.yaml`)に、既存パターン(例 `"postcss@<8.5.13": "8.5.15"`)へ合わせ
> **per-major** で書く。素の `"undici": ...` は別 major の利用者を壊すので避け、
> `"undici@6": "^6.27.0"` / `"undici@7": "^7.28.0"` のように major ごとに固定する。

### 4. 検証

`pnpm install`(lockfile 更新)後:

- `pnpm lint`(errors=0 必須)
- 影響パッケージの `pnpm --filter <pkg> type-check`
- 影響パッケージに **test があれば** その test(`pnpm --filter <pkg> test`、api は flaky 回避で単独実行)。**無ければ** build + type-check で API 互換を確認し、可能なら最小 test を足して以後の bump を守る(特に **major bump** は実 runtime を 1 経路通すと安心。例: nodemailer なら `createTransport({ jsonTransport: true })` + `sendMail`)。
- 公開パッケージの bump は changeset を追加(patch/minor/major は内容で判断)。

### 5. commit(push しない)

- `fix(deps): bump <pkg> to <ver> (#<alert> / GHSA-xxxx)` など。本文に「なぜこの版で
  直るか」「override にした理由」を残す。
- major upgrade 待ちの未対応分は報告に 1 行残すだけにする (退避先は無い —
  `pnpm outdated` がいつでも再導出する)。
- **push は user 指示待ち**(commit まで)。

## 出力

直した alert(番号 + package + 版)/ override にしたもの(+理由)/ major 待ち(+ブロッカー)
/ 残件を、簡潔に表で。全件対応済み or 全件 major 待ちならその旨一言。

## crowi-orchestrate との関係

- **D 系統 = watcher**: 新規 alert の検知 + 報告 + `knownDependabotAlerts` のメンテのみ。
- **この skill = fixer**: 実際に直す。D が「新規あり」を出したら user が `/crowi-deps` を
  打つ(D が high/critical を見たら ping)。**fix のロジックはこの skill に一本化**する。
