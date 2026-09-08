---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Open the whole month in the page sidebar when you are inside a date hierarchy. Crowi's flow-note idiom (`<notebook>/YYYY/MM/DD/<title>`) leaves one or two pages under each day, so the sidebar used to show a column of bare day numbers and open only the day you were on — a shape that says nothing about what any other day holds. From a `YYYY/MM/` node and anywhere below it, every day of that month now lists the pages inside it, turning the rail into a readable month log; a year node still lists only its months, as before. The node you are on is scrolled into view when the opened month runs longer than the rail. `GET /pages/children` gains an optional `depth` (1-2, default 1) that widens the response to that many levels, returned as one flat list where each row carries its full path; the server already scanned the whole subtree, so a deeper request costs no extra query, and omitting `depth` returns exactly what it always did.
