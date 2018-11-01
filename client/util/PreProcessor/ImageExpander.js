export default class ImageExpander {
  replaceText(text) {
    return text.replace(/\s(https?:\/\/[\S]+\.(jpg|jpeg|gif|png))/g, ' <a href="$1"><img src="$1" class="auto-expanded-image"></a>')
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
