# RFC-0013 Slack plugin — remaining open points (実装時に詰める)

RFC-0013 (`0013-slack-plugin.md`) の §12 で**大半は決定済み**。ここには
「**まだ決まっていない / 実装着手時に設計を切る**」項目だけを残す。決定済みの
判断は RFC 本体 §12 Decisions を参照。

## いつ・何を決めるか

### Phase E(Slack→Crowi 埋め込み)着手時
- [ ] **汎用 embed-affordance の SDK 面の形**(RFC §12.8)— 一番大きい未設計。
  - プラグインが「URL パターン + フローティングアクション label + 変換
    (→ `@[slack](url)`)」を**どう宣言するか**(plugin-api の新 surface)。
  - web エディタが登録ルールを**一覧取得する API** と、**変換を適用する口**。
  - エディタは検知+ボタン表示のみ、アクションはプラグインに委譲(Slack 固有
    コードをエディタに置かない)。→ Phase E 開始時に短い設計メモを別途。
- [ ] **AuthContext 実装の詳細**(RFC §12.9 / §7.5)— 「ここで実装」は決定済み。
    残るは配線の具体: `createAuthContextStub`(`renderer/registry.ts`)を実体化し、
    描画中に**当該プラグインの暗号化 config namespace** を `ctx.auth.config(schema)`
    で読めるようにする。共有オーナートークン方式(全描画で1トークン)。
    エッジ: 未設定時の挙動、復号失敗、キャッシュキーとトークンの関係。
- [ ] **private チャンネルの招待 UX**(RFC §12.10)— public は `conversations.join`
    自動参加で解決。private は「Crowi bot を招待して」ロックカードの文言/導線。

### Phase 2(slash 書き込み)着手時 — ここが構造的に重い
- [ ] **アカウント連携(Sign in with Slack / link)の機構**(RFC §7.4 / §12.2)。
  - slash の**書き込み**と**メンションのマッピング**は本人認証が前提
    (email 推測は不可)。read-only `/crowi search` は bot 権限で可。
  - `registerAuth` + OAuth callback(Phase 0 authed route)で Slack↔Crowi link
    を実装。social login(RFC-0001 Step 10 / RFC-0010)が戻るかと独立に、
    **write を出すなら link は必須**。link の保存先(User に slackUserId 等)も設計。
- [ ] **「thread → wiki ページ」の細部** — どのページパスに作るか、本文整形
    (mrkdwn→markdown)、作成者 = link した Crowi ユーザー。

### Phase 1(unfurl)/ 共通
- [ ] **dev トンネルの override の口**(RFC §12.5)— `CLIENT_URL` が SSOT だが、
    dev は Slack が到達できる公開 URL(ngrok/cloudflared)が要る。manifest の
    `request_url` を dev で差し替える env を決める。

### Phase 3(通知)
- [ ] **通知 UX 全般**(RFC §12.7 / §7.3)— **保留**。トリガー(どのイベント)/
    バッチ/チャンネル別ルールは別設計。notifier の配線(`registerNotifier` +
    `forwardToNotifierPlugins`)と per-page channel(`pageMetadataSchema`)は
    インフラとして用意できるが、UX は後。

## 決定済み(備忘・詳細は RFC §12)
統合 Slack プラグイン / registerRoutes は Hono Context ハンドラ+public+生ボディ /
unfurl は public のみ+非公開ロック / `@slack/web-api` 採用 / 単一ワークスペース /
埋め込み trigger は `@[slack](url)` opt-in(エディタ affordance で貼付→変換)。

関連: 設計本体 `docs/rfcs/0013-slack-plugin.md`、RFC-0001(プラグイン)、
RFC-0002(レンダラー / AuthContext)、RFC-0004(エディタ)、RFC-0010(OAuth)。
