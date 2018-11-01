export default class PageLinker {
  replaceText(text) {
    const replacer = '<a href="$1">$1</a>'
    // ページ間リンク: [] でかこまれてて / から始まる
    text = text.replace(/^\[(\/[^\]]+?)\](?!\()/g, replacer)
    text = text.replace(/\s\[(\/[^\]]+?)\](?!\()/g, ' ' + replacer)
    // ページ間リンク: <> でかこまれてて / から始まり、 / が2個以上
    text = text.replace(/^<((\/[^>]+?){2,})>/g, replacer)
    text = text.replace(/\s<((\/[^>]+?){2,})>/g, ' ' + replacer)
    return text
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
