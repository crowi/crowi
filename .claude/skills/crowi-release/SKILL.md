---
name: crowi-release
description: |
  リリースの指揮 skill。pre-flight(changeset / 未統合 worktree / CI 状態 / Version PR)→
  Go/No-Go 材料の提示 →(ユーザー承認後の)Version PR merge → タグ後の成果物検証
  (npm / Docker / GitHub Release / team wiki の記録)。merge / tag / publish は常にユーザー承認後。
  検証は成果物に対して read-only(wiki の記録だけは欠けていれば書く)。
  キーワード: release, リリース, alpha, タグ, publish, Version PR, 成果物検証, Go/No-Go
---

# Crowi Release (リリース指揮: pre-flight → GO → verify)

リリースは CI が自動化済み。この skill は **CI の外側に残る人間側の仕事** — 「いつ切るか」
の判断材料づくりと「ちゃんと出たか」の検証 — を定型化する。運用者向けの正本ドキュメントは
`apps/crowi-site/content/docs/{ja,en}/develop/release-runbook.mdx`(外部設定・
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
| **team wiki の記録**(詳細ページ + index の 1 行) | **この skill(verify モード)** | CI は書かない — portal `/crowi/release/` の運用契約 |
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
6. **QA / prod build スモーク**: 既定で `/crowi-qa main --prod-build`(全 charter)を
   呼ぶ。人間が明示的にスキップを指示した場合のみ実行せず、Go/No-Go 材料に
   `prod build: skipped(human instruction)` として記録する(黙って省略しない)。
   実行した場合は結果(`ready` / `blocked` / 主要 finding の要約)を
   `prod build: <verdict>` として同じ材料に反映する。

**提示フォーマット**:

```
## <次バージョン> リリース判定材料
入るもの: <changeset ベースの feat/fix 一覧>
入らないもの(未統合 worktree): <id: N commits, 状態>
リスク / 未検証: <あれば>
CI: main <green/red> / Version PR: #NNN <open/none>
prod build: <verdict> (例: ready / blocked: <理由> / skipped(human instruction))
→ Go なら Version PR #NNN の merge を指示してください。
```

**ここで必ず止まる。** merge はユーザーの明示指示があった場合のみ
`gh pr merge <N> --squash`(以降は CI が publish → tag → image → 告知まで自動)。

## モード 2: verify(タグ後 — 成果物は read-only、wiki の記録だけ書く)

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
5. **wiki の記録**: team wiki の portal(`/crowi/release/`)が冒頭で「リリースを切るたびに
   **変更点の詳細ページを 1 枚**書き、この表に**一行要約**を足す」と定めている。CI はこれを
   やらないので、**verify がこの 2 つを確認する**(欠けていれば書く。詳細ページと index
   追記は必ず対になる — 片方だけでは portal から辿れない、または表に載らない):

   ```bash
   crowi -p crowi-team-wiki get /crowi/release/<YYYY>/<MM>/<DD>/alpha-<N>   # 詳細ページ
   crowi -p crowi-team-wiki get /crowi/release/ | grep 'alpha-<N>'          # index の行
   ```

   日付はタグの作成日(`git log -1 --format=%ci <tag>`)を**ローカル時刻で**使う。UTC で
   採ると日付が 1 日ずれることがある。書式は既存ページに合わせる(詳細ページは「前の
   リリースからの変更点」+ 立場ごとの対応要否の表から始める。index は 1 行要約)。

   依存パッケージの脆弱性対応を書くときは主語を取り違えない(`crowi-changesets` の
   「依存パッケージの脆弱性対応の書き方」が正本)。詳細ページと index の 1 行の両方に
   効く。

   書くときは CLAUDE.md の wiki 書き込み規約に従う — **本文はファイルに書き、`crowi ...
   --file` で渡し、`crowi get | diff` で一致を確認する**(末尾改行 1 行だけの差は一致と
   みなす)。index への追記は取得 → プログラムで 1 行挿入 → 元との diff が「追加 1 行のみ」
   を確認 → 書き戻し、の順で行い、本文を手で組み直さない。

   この項目がある理由: alpha.17 で index への追記が漏れた。npm / Docker / GitHub Release
   だけを見る verify は、成果物が全部揃っていても記録の欠落を検出できない。
6. 結果を表で報告。**失敗があっても修正・再 publish はしない**(報告 + 対応案の提示まで。
   image の再ビルドは `docker.yml` の workflow_dispatch — 実行は人間の判断)。
   ただし **wiki の記録だけは verify が書いてよい**(read-only の例外)。成果物ではなく
   記録なので、再 publish のような不可逆な操作を伴わないため。

## 鉄則

- **merge / tag / push / publish はすべてユーザーの明示承認後**(pre-flight は提示で止まる)
- verify は**成果物に対して** read-only(docker pull/run はローカルのみ・`--rm` 付き)。
  例外は wiki の記録(手順 5)だけ — 成果物ではなく記録で、不可逆な操作を伴わないため
  verify が書いてよい
- 失敗成果物の修正・再 publish を自動でしない
- レビュー的な指摘が出たら fix or drop(退避先は存在しない — 全 skill 共通方針)
- **prod build スモーク(`/crowi-qa main --prod-build`)は既定で実行**。省略するのは
  人間が明示的にスキップを指示した場合のみで、その旨を Go/No-Go 材料に記録する
  (黙って省略しない)

## 手動フォールバック(CI が壊れて手動 publish に戻るとき)

通常運用では CI が publish → tag → image → 告知まで行う(冒頭の境界表)。この節は CI が
使えないときだけの経路。**運用の正本は
`apps/crowi-site/content/docs/{ja,en}/develop/release-runbook.mdx`** で、外部設定・
dist-tag・channel 切替はそちらが持つ。

手順は CI がやっていることを手で行う:

1. `pnpm changeset version`(pre mode 中ならそのまま)で version bump + CHANGELOG を
   最終 commit として積む
2. リリースブランチを push → main への PR を 1 本作って merge。**tag は出荷された
   コードが乗る main のコミットを指すべき**で、かつ main への直 push は避けるため、
   この順序を崩さない
3. merge 後の main に `git tag v<dist-version>` → push。`<dist-version>` は
   `node scripts/compute-dist-version.mjs` の算出値(npm のパッケージ版とは別カウンタ)
4. `pnpm changeset publish` で npm へ
5. Docker image を `scripts/release-tags.mjs` の tag 規則どおり multi-arch で build + push

**手動に落ちた瞬間、CI が吸収していた罠が戻ってくる**(CI 経路では解消済みに見えるが、
解消しているのは「CI がやっている間」だけ):

- **npm の OIDC Trusted Publishing は CI でしか効かない。** 手動 publish には token か
  2FA の対話が要る
- **macOS の buildx は default builder のままだと multi-arch を push できない。**
  `docker buildx create --use` で builder を作ってから push する
- **新規パッケージの初回だけは Trusted Publisher を設定できない**(npm 上に存在しない
  名前には登録不可)。1 回手で publish してから登録する — 詳細は runbook が正本
