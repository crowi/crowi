import emojify from 'emojify.js'

export default class Emoji {
  constructor() {
    emojify.setConfig({
      img_dir: '/emoji_images/basic',
    })
  }

  process(markdown: string) {
    return emojify.replace(markdown)
  }
}
