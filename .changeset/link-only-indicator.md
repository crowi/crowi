---
'@crowi/web': patch
---

GRANT_RESTRICTED (「リンクを知っている人のみ」)のページにアイコン
インジケータを追加。 これまで SPECIFIED / OWNER のみが Lock アイコンで
区別され、 RESTRICTED は public と見分けがつかなかった。 PageListItem
の行頭と PageHeader (展開時 + sticky 時) に Link2 アイコンを追加し、
「リンクを共有された誰でも見られる」と「リスト指定ユーザだけ」を
視覚的に分離した。
