---
'@crowi/api': minor
'@crowi/web': minor
---

Turn the special `/user/` page into a member directory. It now leads with a card grid of workspace members (avatar + display name + @username, each linking to that user's page) above the usual list of pages under `/user/`. A "Show all" link opens a dedicated `/_user` directory with a username/name search box and pagination. Creating a portal document at `/user/` is no longer offered (and is rejected server-side), since the path is reserved for the directory; individual user pages such as `/user/alice` are unaffected.

Adds a new authenticated endpoint `GET /users` that lists active users (name-ascending, searchable by username/name, offset-paginated). The directory payload is intentionally minimal — avatar, display name, and username only; email is never exposed.
