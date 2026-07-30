---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

Notification updates now reflect in realtime (polling removed, replaced by a WebSocket invalidation signal).

Removed the polling where `useUnreadCount` hit `GET /notifications/status` every 30 seconds, and added a `/notifications/<userId>` WebSocket channel to the api process. When a server operation such as Notification.create / markAsRead / markAsOpened / markAllAsRead happens, the api instance the affected user is connected to pushes `{"type":"changed"}` via Redis pub/sub (channel: `crowi:notifications:user:<userId>`). On receiving the signal, the web side invalidates the react-query keys under `notificationKeys.all` and refetches the latest value from the existing REST API (i.e. a hybrid that does not push the data itself).

- New endpoint: `GET /api/notifications/token` (short-lived JWT, issuer=`crowi-notifications`, TTL 60s)
- New WebSocket: `/notifications/<userId>?token=<jwt>`
- Redis required: a multi-instance setup needs `REDIS_URL` (the same pub/sub mechanism as presence / collab). Single-instance dev without `REDIS_URL` runs in a degraded mode where the WS connects but invalidation signals don't arrive.
- Compatibility: the existing REST API is unchanged; the only difference from the UI is that the polling requests disappear.
