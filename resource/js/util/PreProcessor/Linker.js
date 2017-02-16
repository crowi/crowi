var path = require('path');

export default class Linker {
  process(markdown) {

    return markdown
      //.replace(/\s(https?:\/\/[\S]+)/g, ' <a href="$1">$1</a>') // リンク
      .replace(/\s<((\/[^>]+?){2,})>/g, ' <a href="$1">$1</a>') // ページ間リンク: <> でかこまれてて / から始まり、 / が2個以上
      .replace(/\[\[(.*)\]\]/g, function(all, group1) {
        var url = path.join(window.location.pathname, group1);
        return `<a href="${url}">${group1}</a>`
      });
      ;
  }
}
