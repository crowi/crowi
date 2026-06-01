# メール機能 QA 手順書

Crowi 2.0 のメール基盤（sender plugin / HTML テンプレ / invite / activation /
password reset）の手動 QA 手順。実機（`pnpm dev` + Mailpit）で実施する。

- 進め方の順序: **0 疎通 → 7 回帰(ロックアウト非発生) → 2〜4 正常系 → 5 i18n/見た目 → 6 異常系**
- 最優先は **0 と 7**。ここが壊れると全員がログイン不能になり得るため最初に確認する。
- 自動テスト(jest 914 件)が正常系/異常系の多くをカバー済み。手動 QA は「見た目」「メールクライアント互換」「リンク踏破の通し」に注力する。

## 環境
- `docker compose up -d`（mongo / redis / mailpit など）
- `pnpm dev`（api :4301 / web :4302）
- Mailpit: SMTP `localhost:1025` / 受信箱 UI http://localhost:8025
- ログ: `DEBUG=crowi:*`（`crowi:service:mail` / `crowi:hono:handlers:*` で送信可否・トークン検証理由が見える）
- トークン有効期限: invite 7日 / activate 1日 / reset 1時間

---

## 0. 事前準備・疎通
- [ ] `/admin/plugins` の **SMTP** カード: `host=localhost` / `port=1025` / user・password 空 / secure off で保存
- [ ] `/admin/mail` で **From**（例 `noreply@example.com`）を保存
- [ ] `/admin/mail` の **テスト送信** → Mailpit に届く
- [ ] ここで失敗するなら以降も失敗する。先に解消する

## 1. sender plugin 基盤
- [ ] `/admin/mail` の「有効な送信方法」が `smtp` 表示
- [ ] 「プラグイン設定を開く」が SMTP の編集画面（`/admin/plugins/edit?name=@crowi/plugin-mail-smtp`）へ直リンク
- [ ] SMTP の host を変更 → 保存（reconfigure）→ **再起動なし**で次のテスト送信に反映
- [ ] (任意) `crowi.config.json` の `mail.driver` を `resend` / `ses` に変更 → active driver 表示が切り替わる（送信実体は各 SDK 設定が必要）

## 2. invite フロー（管理者招待）
- [ ] `/admin/users` から招待（メール送信 ON）→ Mailpit に HTML 招待メール
- [ ] メール内 CTA → `/invite/accept?token=...` で「○○ さんとして参加」表示
- [ ] username / 表示名 / パスワード設定 → 送信 → **自動ログインで `/` 着地**
- [ ] 招待ユーザーは**メール確認不要**（リンク踏破が確認）
- [ ] 受諾後に同じリンクを再度踏む → 「既に受諾済み」

## 3. activation フロー（自己新規登録）
- [ ] `/register` で登録 → 「メールを確認してください」表示（**自動ログインしない / トークンは返らない**）
- [ ] この状態で `/login` → **「メール未確認」で 403**
- [ ] Mailpit の activation メールの CTA → `/activate?token=...` → 自動で有効化されサインイン → `/` 着地
- [ ] 有効化後に `/login` できる

## 4. password reset フロー
- [ ] `/login` の「パスワードをお忘れですか?」→ `/forgot-password` でメール入力 → 「メールを確認してください」表示
- [ ] Mailpit の reset メールの CTA → `/reset-password?token=...` → 新パスワード設定 → 自動ログイン
- [ ] 古いパスワードでログイン不可 / 新パスワードでログイン可

## 4b. その他のメール
- [ ] **テスト送信**は HTML 化されている（`/admin/mail` のテスト送信 → ブランド付き HTML）
- [ ] **パスワード変更通知**: パスワードリセット完了時・`/me` のパスワード変更時に本人へ「変更されました」通知が届く
- [ ] **承認待ち通知**: RESTRICTED モードで自己登録 → 管理者全員に「承認待ちユーザーがいます」（CTA: ユーザー確認）
- [ ] **メールアドレス変更の確認**: `/me` でメール変更 → **即時変更されず**、新アドレスに確認リンク → `/confirm-email?token=` を踏むと確定。確定まで旧アドレスのまま

## 5. i18n・メールの見た目
- [ ] ユーザーの `lang` を ja / en に変えて、各メールの**件名・本文が切り替わる**
      （reset / activation は受信者の lang、invite は app デフォルト言語）
- [ ] Mailpit でロゴ・CTA ボタン・ブランド・フッタが崩れていない
- [ ] text パートが入っている（Mailpit でテキスト表示に切替）
- [ ] (推奨) 実際の Gmail / Outlook へ転送してレンダリング確認

## 6. 異常系・セキュリティ
- [ ] **無効/改竄トークン**: token を書き換えた URL → invite/activate/reset いずれも「無効なリンク」表示
- [ ] **期限切れ**: TTL 超過のリンク（or 時刻操作）→ 無効
- [ ] **purpose 流用**: reset のトークンを activate に使う等が弾かれる（jest 済 / 手動は任意）
- [ ] **二重使用**: invite/activate 受諾後の同リンク再使用が弾かれる
- [ ] **enumeration 対策**: `/forgot-password` に**存在しないメール**を入れても、存在時と同じ「送信しました」表示
- [ ] **From 未設定**: `/admin/mail` の From を空にしてテスト送信 → 502
- [ ] **SMTP 未設定**で自己登録 → 登録自体は完了（送信失敗は握りつぶす）。この環境では確認メールが届かない＝activation 未完了になる挙動を理解

## 7. 回帰（最重要: ロックアウト非発生）
- [ ] **既存 ACTIVE ユーザー**（installer 管理者含む）が普通にログインできる
      （`emailConfirmedAt` 未設定でも `status` だけで判定される設計）
- [ ] installer 直後の管理者ログイン
- [ ] 既存機能（ページ閲覧/編集、collab、検索 等）がメール変更の影響を受けていない

---

## トラブルシュート
- メールが届かない → Mailpit(8025) ではなく API ログの `crowi:service:mail` を確認（host/from/送信失敗理由）
- リンク先で固まる → ブラウザ devtools の Network で `/api/v2/auth/*` / `/api/v2/invite/accept` のレスポンスを確認
- `getBaseUrl()` が null（BASE_URL も app:url も未設定）だとメール内 URL が壊れる → `app:url` を設定
