---
'@crowi/api': minor
'@crowi/web': minor
---

`/_edit` ページが viewport 全体に貼り付く layout になり、 編集 header と
保存 footer が画面に固定された状態で editor と preview がそれぞれ独立に
内部スクロールするようになった。

加えて、 editor と preview の **双方向 scroll sync** を実装。 旧 Crowi
の単純な scrollTop 比例ではなく、 行 + ブロック内オフセット ratio を
組み合わせた fractional-line interpolation で同期するため、 code fence や
list のような長いブロック内でも連続的に追従し、 line の頭にガクッと
ジャンプしない。 サーバ側で preview 用 mdast の top-level 各ノードに
`data-source-line` を埋め込み (`POST /api/v2/pages/preview`)、 web 側の
`useScrollSync` hook がその marker と CodeMirror の line block 情報を
線形補間でつなぐ。 editor → preview / preview → editor の round-trip は
bijection になっており、 操作を行き来しても位置が drift しない。
