export default class ImageExpander {
  replaceText(text) {
    const replacer = '<a href="$1"><img src="$1" class="auto-expanded-image"></a>'
    text = text.replace(/^(https?:\/\/[\S]+\.(jpg|jpeg|gif|png))/g, replacer)
    text = text.replace(/\s(https?:\/\/[\S]+\.(jpg|jpeg|gif|png))/g, ' ' + replacer)
    return text
  }

  process(tokens) {
    const { links } = tokens
    tokens = tokens.map(token => {
      const { type, text = '' } = token
      if (token) {
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
