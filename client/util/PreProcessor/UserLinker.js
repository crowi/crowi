export default class UserLinker {
  constructor(crowi) {
    this.crowi = crowi
  }

  replaceText(text) {
    const regexp = /((?:^|[^a-zA-Z0-9_＠!@#$%&*`]))((?:(?:@|＠)(?!\/))([a-zA-Z0-9-_.]+))(?:\b(?!@|＠)|$)/g
    return text.replace(regexp, (match, before, screenName, userName) => {
      const user = this.crowi.findUser(userName)
      if (user) {
        return `${before}<a class="mention" data-id="${user._id}" href="/user/${userName}">@${userName}</a>`
      }
      return match
    })
  }

  process(tokens) {
    const { links } = tokens
    tokens = tokens.map(token => {
      const { type, text = '' } = token
      if (token) {
        switch (type) {
          case 'paragraph':
          case 'heading':
            return { ...token, text: this.replaceText(text) }
        }
      }
      return token
    })
    tokens.links = links
    return tokens
  }
}
