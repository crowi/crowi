---
"@crowi/web": minor
---

Keep editors signed in when a session expires mid-edit instead of bouncing them to the login screen. When the access token lapses while editing a page, the app first tries a silent refresh using the still-valid refresh token, so in the common case nothing is shown and editing continues uninterrupted. Only when the refresh token has also expired does a non-dismissible re-login modal appear in place, letting the user re-authenticate without leaving the editor. Throughout, the in-progress Y.Doc and any unsaved input are preserved (the editor is never unmounted), and on recovery the collaborative connection, autosave, and presence all reconnect by refetching the short-lived collab/presence tokens. Re-authenticating in one browser tab also recovers every other open editor tab via a storage event, closing their modals and reconnecting them. The new-page (create) flow is out of scope and keeps its previous behaviour of redirecting to login.
