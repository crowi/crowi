export default class SectionFixer {
  extractHeading(text) {
    return /^(#{1,})((?![\s#]+).+)$/gm.exec(text)
  }

  process(tokens) {
    const { links } = tokens
    tokens = tokens.map(token => {
      const { type, text = '' } = token
      if (token) {
        switch (type) {
          case 'paragraph':
            const [isHeading, hashes, heading] = this.extractHeading(text) || [null, null, null]
            return isHeading ? { ...token, type: 'heading', depth: hashes.length, text: heading } : token
        }
      }
      return token
    })
    tokens.links = links
    return tokens
  }
}
