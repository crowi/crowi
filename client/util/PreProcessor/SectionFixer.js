export default class SectionFixer {
  extractHeading(text) {
    return /^(#{1,})((?![\s#]+).+)$/gm.exec(text)
  }

  process(tokens) {
    const { links } = tokens
    let level = 0
    tokens = tokens.map(token => {
      const { type, text = '' } = token
      if (token) {
        switch (type) {
          case 'paragraph':
            const [matches, hashes, heading] = this.extractHeading(text) || [null, null, null]
            const isHeading = matches && hashes.length <= 6
            if (level === 0 && isHeading) {
              return { ...token, type: 'heading', depth: hashes.length, text: heading }
            }
            break
          case 'blockquote_start':
            level++
            break
          case 'blockquote_end':
            level--
            break
        }
      }
      return token
    })
    tokens.links = links
    return tokens
  }
}
