---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

通知の更新をリアルタイム反映 (polling 廃止、WebSocket invalidation 信号化)。

`useUnreadCount` が 30 秒ごとに `GET /notifications/status` を叩いていた
ポーリングを廃止し、api process に `/notifications/<userId>` WebSocket
チャンネルを追加。Notification.create / markAsRead / markAsOpened /
markAllAsRead 等のサーバ操作が起きると、Redis pub/sub (channel:
`crowi:notifications:user:<userId>`) を経由して該当ユーザーが接続している
api インスタンスから `{"type":"changed"}` を push する。Web 側は信号を
受け取ると `notificationKeys.all` 配下の react-query を invalidate し、
既存 REST から最新値を取り直す (= データ本体は push しないハイブリッド)。

- 新規エンドポイント: `GET /api/v2/notifications/token` (短命 JWT,
  issuer=`crowi-notifications`, TTL 60s)
- 新規 WebSocket: `/notifications/<userId>?token=<jwt>`
- Redis 必須: multi-instance 構成では `REDIS_URL` が必要 (presence /
  collab と同じ pub/sub 機構)。`REDIS_URL` 無しの single-instance dev は
  WS は接続するが invalidation は届かない degrade モードで動作
- 互換性: 既存の REST API はそのまま、UI からは polling リクエストが
  消えるのみ
