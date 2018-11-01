export default class PageLinker {
  replaceText(text) {
    return text
      .replace(/\s\[(\/[^\]]+?)\](?!\()/g, ' <a href="$1">$1</a>') // ページ間リンク: [] でかこまれてて / から始まる
      .replace(/\s<((\/[^>]+?){2,})>/g, ' <a href="$1">$1</a>') // ページ間リンク: <> でかこまれてて / から始まり、 / が2個以上
  }

  process(tokens) {
    const { links } = tokens
    tokens = tokens.map(token => {
      if (token) {
        const { type, text = '' } = token
        switch (type) {
          case 'paragraph':
            return { ...token, text: this.replaceText(text) }
        }
      }
      return token
    })
    tokens.links = links
    return tokens
  }
}
