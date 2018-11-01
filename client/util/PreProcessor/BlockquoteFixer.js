export default class BlockquoteFixer {
  process(tokens) {
    const { links } = tokens
    let level = 0
    tokens = tokens.reduce((tokens, token, index) => {
      const prev = tokens[index - 1] || {}
      const { text } = prev
      const { type } = token
      if (token) {
        switch (type) {
          case 'space':
            if (level && prev.type === 'paragraph') {
              tokens[index - 1] = { ...prev, text: text + '<br><br>' }
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
      return [...tokens, token]
    }, [])
    tokens.links = links
    return tokens
  }
}
