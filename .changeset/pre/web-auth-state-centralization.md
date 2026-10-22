---
"@crowi/web": patch
---

Centralize the web client's auth state on a single React Query source so session changes propagate consistently across the whole UI.

Logging out — or a session expiry / a logout in another tab — now wipes the entire client cache, so signing in as a different user afterwards never shows the previous user's pages, notifications, or other cached data. A logout in another tab also propagates to the current tab, which navigates to the login screen instead of staying on a stale authed view; re-logging in as a different account in another tab likewise swaps the current tab over to the new user.

Re-authenticating inline in the editor (the session-expiry modal) now restores the signed-in user immediately instead of leaving the header empty, and if another tab logs out while the editor holds an unsaved buffer, the current tab opens the inline re-auth modal in place rather than redirecting and discarding the buffer. Authenticated reloads and transient server (5xx) blips at startup no longer flash the header into a "logged out" state.
