---
"@crowi/web": patch
---

Keep a page that also has pages under it (e.g. `/team/docs` alongside `/team/docs/guide`) reachable from where you would look for it. The sidebar now lists it at the top of its folder whenever that folder is open, including while you are viewing one of the pages inside it (previously it disappeared as soon as you opened a child page). The folder's page list (`/team/docs/`) now shows it as the first row, next to the "this path has content" banner, instead of listing only the pages inside the folder.
