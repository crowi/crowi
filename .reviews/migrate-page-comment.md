# Review: migrate-page-comment

- **Decision**: APPROVED
- **Reviewed at**: 2026-05-05
- **Attempt**: 1

## Summary

ts-rest 契約 + API ハンドラ + Next.js UI までのフルスタック移行が要件・受け入れ基準を満たしている。
auth ガード、grant チェック、エラーマッピング、テストカバレッジ (13/13 PASS、API 全 119 PASS) が揃っており、
旧 `/_api/comments.*` の挙動も `addComment` への意図的な grant 強化を除いて維持されている。

## 自動チェック

| Check | Result |
| --- | --- |
| `pnpm --filter @crowi/api-contract build` | PASS |
| `pnpm --filter @crowi/api type-check` | PASS |
| `pnpm --filter @crowi/web type-check` | PASS |
| `pnpm --filter @crowi/api test` (full) | PASS (119 passed, 2 skipped) |
| `pnpm exec prettier --check apps/crowi-api/...comment*` | PASS |
| `pnpm exec prettier --check` (web/api-contract) | drift, but consistent with existing convention (no `format` script in those packages — `pnpm format` only targets `@crowi/api`) |

`apps/crowi-web` と `packages/api-contract` には `format` script がないため `pnpm format` 対象外で、
既存の `page-view.tsx` 等も同様に root prettier (printWidth 160) 基準では drift している。
プロジェクトの既定動作と一致しているため、format 観点での NEEDS_WORK 扱いはしない。

## 必須観点 (1〜6)

| # | 観点 | 結果 | 根拠 |
| --- | --- | --- | --- |
| 1 | 契約整合 | PASS | `commentContract` の status コードと実装の return が完全一致 (200/400/401/403/404)。Zod スキーマ (`CommentSchema`, `AddCommentRequestSchema`, `DeleteCommentRequestSchema`) に対し `commentToResponse` が型整合する形で出力。 |
| 2 | 認証 | PASS | `commentRouter` が `authenticatedRouter` (`jwtAuth` 適用) 配下に組み込まれており、未認証 401 を 3 エンドポイント分テスト済み (`AUTHENTICATION_REQUIRED`)。 |
| 3 | 旧実装互換 | PASS (差分は openQuestions 通り) | `addComment` で `Page.findPageByIdAndGrantedUser` を新規追加 (旧は無検査) — openQuestions で「入れる方針」と決定済み。`DELETE` のレスポンスは `{ ok: true }` に簡略化 (旧は `removeCommentById` の戻り値そのまま) — openQuestions で確認済み。`comment_position` は受け取りのみで UI 未対応 (line-anchored は scope 外) — task 要件と整合。 |
| 4 | エラーマッピング | PASS | jwtAuth=401 / `INVALID_REQUEST`=400 / `PAGE_NOT_GRANTED`=403 / `PAGE_NOT_FOUND` or `COMMENT_NOT_FOUND`=404 が意味論的に妥当。`addComment` で grant 違反を 404 に丸めるのは情報リーク回避として適切 (テストも反映)。 |
| 5 | トランザクション境界 | PASS | `Comment.create` post-save hook が `Page.commentCount` と `Activity` を更新する仕組みに依存しており、ts-rest 層で重複処理なし。テスト `creates a comment and increments Page.commentCount` で動作確認済み。 |
| 6 | テストカバレッジ | PASS | 全受け入れ基準 (auth/正常/異常/grant) を 13 ケースで網羅。`commentCount` の post-save hook 反映までポーリングで検証。 |

## 望ましい観点 (7〜9)

- `comment.ts:154-160` の `findPageByIdAndGrantedUser` 戻り値を nullable と扱っている分岐 (`if (!page) ... 404`) は dead-code (実装は throw する)。挙動には影響しないが、catch 節の message マッピングに任せて簡素化できる。
- `page-comments.tsx:25` の `revisionId = typeof page.revision === 'object' ? page.revision._id : (page.revision ?? null)` は `PageWithRevision` 型では常に object 側に倒れる。型と矛盾しない過剰防御。
- `CommentSchema.creator` の `string` フォールバックも、API 側で常に `populate('creator')` する前提なら不要。ただし populate 漏れの誤魔化しを避けたい意図として残す価値はある。
- `page-comments.tsx` で `useState(pendingDeleteId)` を使い `isDeleting` をコメント単位で表現している点は良い UX。複数同時削除時のロック整合を考えると単一 ID 制約で十分。
- 旧 `pageData.isGrantedFor(user)` が delete 時に false の場合、旧仕様は `ApiResponse.error('Permission error')` (HTTP 200 + ok:0) だった。新側 403 は意味論的に正しく、UI もそれに追従しており互換問題なし。

## Advisories (後続タスク候補)

- **page-list-item の commentCount バッジ**: 旧 `views/widget/page_list.html:28-30` 相当の表示を `apps/crowi-web/src/components/page-list-item.tsx` に移植する後続タスク。
- **コメントの Markdown レンダリング**: 現状は `whitespace-pre-wrap` でプレーンテキスト。`PageContent` と共通化して Markdown 化する後続タスク。
- **`findPageByIdAndGrantedUser` の戻り値型整理**: 共通の throw -> ApiError マッピングをユーティリティ化すると `addComment` / 他の grant チェック箇所で重複コードを減らせる。
- **コメント編集 (PUT)**: 現状は scope 外。delete + 再投稿で代替。
- **line-anchored comment**: `comment_position` は受信のみ、UI 表現は Phase 2 以降。
- **PageComments の dead-code 整理**: 上記 7-8 の防御コードは後で簡素化候補。

## Next Action

APPROVED — migration-committer に進む。
