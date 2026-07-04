---
name: crowi-release
description: |
  リリースの指揮 skill。pre-flight(changeset / 未統合 worktree / CI 状態 / Version PR)→
  Go/No-Go 材料の提示 →(ユーザー承認後の)Version PR merge → タグ後の成果物検証
  (npm / Docker / GitHub Release)。merge / tag / publish は常にユーザー承認後。検証は read-only。
  キーワード: release, リリース, alpha, タグ, publish, Version PR, 成果物検証, Go/No-Go
---

# Crowi Release (リリース指揮: pre-flight → GO → verify)

リリースは CI が自動化済み。この skill は **CI の外側に残る人間側の仕事** — 「いつ切るか」
の判断材料づくりと「ちゃんと出たか」の検証 — を定型化する。運用者向けの正本ドキュメントは
`apps/crowi-site/content/docs/{ja,en}/operations/release-runbook.mdx`(外部設定・
Trusted Publisher 等はそちら)。この skill はエージェント手順に徹する。

## CI がやること / この skill がやること(境界表・workflow 実測 2026-07)

| 段階 | 担い手 | 実体 |
|---|---|---|
| Version PR の作成・更新 | CI (`release.yml`: push to main → changesets/action) | branch `changeset-release/main` |
| **Version PR を merge するか** | **人間(この skill が材料を出す)** | = 唯一の GO gate |
| npm publish(OIDC・provenance) | CI(merge 後の release.yml 再実行) | `pnpm changeset publish` |
| 配布バージョン算出 + umbrella tag `v*` push | CI | `scripts/compute-dist-version.mjs` |
| GitHub Release(集約ノート) | CI | `scripts/aggregate-release-notes.mjs` |
| Docker image(crowi/crowi full+slim, crowi/crowi-web, multi-arch) | CI(`docker.yml`: Release 完了の workflow_run 連鎖) | tag 規則は `scripts/release-tags.mjs` |
| Discord 告知 | CI(`docker.yml` 内・real release で自動) | 手動再ビルド時は `announce` input |
| **成果物の検証** | **この skill(verify モード)** | npm / Docker / GH Release |
| ES image | 別 workflow(`docker-elasticsearch.yml`) | 必要時のみ確認 |

> tag push は GITHUB_TOKEN の anti-recursion で docker.yml を**起動しない**。連鎖は
> workflow_run。Version-PR-only run は dist-version artifact を上げないため image build
> は自然に skip される — 「publish したときだけ build」はこの仕組みで担保。

## モード

```
/crowi-release                # pre-flight → Go/No-Go 材料の提示(ここで止まる)
/crowi-release verify [tag]   # タグ後の成果物検証(省略時は最新の v* tag)
```

## モード 1: pre-flight(すべて read-only)

1. **changeset**: `pnpm changeset status` — 溜まっている changeset と bump 内容。
2. **Version PR**: `gh pr list --head changeset-release/main --state open --json number,title,url`
   — open なら差分(CHANGELOG / bump)を要約。無ければ「changeset が無い or CI 未走」。
3. **CI**: `gh run list --branch main --limit 5 --json displayTitle,conclusion,workflowName`
   — main が green か。
4. **前回リリースからの差分**: `git describe --tags --abbrev=0 --match 'v*'` →
   `git log --first-parent --oneline <tag>..main` を feat / fix / その他に分類して要約。
5. **未統合 worktree**(orchestrate E と同じ突合): `git worktree list` の main 以外で
   `main..HEAD` 非空のもの = 「このリリースに**入らない**作業」として列挙。
6. **E2E / QA**: 直近の `pnpm e2e` の実行有無(分かる範囲で)。
   ※ 将来 `/crowi-qa` が入ったらここから呼ぶ(現状は hook のみ)。

**提示フォーマット**:

```
## <次バージョン> リリース判定材料
入るもの: <changeset ベースの feat/fix 一覧>
入らないもの(未統合 worktree): <id: N commits, 状態>
リスク / 未検証: <あれば>
CI: main <green/red> / Version PR: #NNN <open/none>
→ Go なら Version PR #NNN の merge を指示してください。
```

**ここで必ず止まる。** merge はユーザーの明示指示があった場合のみ
`gh pr merge <N> --squash`(以降は CI が publish → tag → image → 告知まで自動)。

## モード 2: verify(タグ後・read-only)

対象 tag(既定 = `git describe --tags --abbrev=0 --match 'v*'` on latest main)について:

1. **CI 完走**: `gh run list --workflow Release --limit 1` と
   `gh run list --workflow Docker --limit 1` が success。
2. **npm**: 公開パッケージを列挙して各バージョンを確認。一覧は**ハードコードしない**
   (workspace が正本):
   ```bash
   for d in packages/*/package.json; do
     node -e "const p=require('./$d'); if(!p.private) console.log(p.name)"
   done | while read pkg; do npm view "$pkg" dist-tags --json | head -3; done
   ```
   publish 漏れ(直近 bump のはずが古い)をゼロ確認。
3. **Docker**: `scripts/release-tags.mjs` の tag 規則に従い(実装が正本)、
   `crowi/crowi:<ver>`(full)/ slim variant / `crowi/crowi-web:<ver>` を
   `docker pull` → 起動スモーク(env 不足エラーに到達すれば「image は壊れていない」で
   OK。完全 boot は求めない):
   ```bash
   docker run --rm crowi/crowi:<ver> node --version   # 最低限
   ```
4. **GitHub Release**: `gh release view <tag>` — 集約ノートが生成されているか。
5. 結果を表で報告。**失敗があっても修正・再 publish はしない**(報告 + 対応案の提示まで。
   image の再ビルドは `docker.yml` の workflow_dispatch — 実行は人間の判断)。

## 鉄則

- **merge / tag / push / publish はすべてユーザーの明示承認後**(pre-flight は提示で止まる)
- verify は read-only(docker pull/run はローカルのみ・`--rm` 付き)
- 失敗成果物の修正・再 publish を自動でしない
- レビュー的な指摘が出たら fix or drop(TODO へ退避しない — 全 skill 共通方針)

## 歴史的経緯(手動時代の gotcha — CI が壊れて手動 publish に戻るときの参照)

- ~~npm publish の 2FA 対話~~ → OIDC Trusted Publishing で不要に(long-lived token なし)
- ~~macOS buildx は default builder で push~~ → CI の multi-arch build に移行済み
- ~~initial-release changeset の手修正~~ → 解消済み(fixed group 運用)
- 手動リリースの完全手順は memory `alpha1_released_2026-06-18` と release-runbook.mdx を参照
