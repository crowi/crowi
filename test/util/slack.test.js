const utils = require('../utils.js')

describe('Slack Util', () => {
  var crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env)
  var slack = require(crowi.libDir + '/util/slack')(crowi)

  test('convert markdown', () => {
    var markdown = '# ほげほげ\n\n* aaa\n* bbb\n* ccc\n\n## ほげほげほげ\n\n[Yahoo! Japan](http://www.yahoo.co.jp/) is here\n**Bold** and *Italic*'
    var markdownConverted = '\n*ほげほげ*\n\n• aaa\n• bbb\n• ccc\n\n\n*ほげほげほげ*\n\n<http://www.yahoo.co.jp/|Yahoo! Japan> is here\n**Bold** and *Italic*'
    expect(slack.convertMarkdownToMrkdwn(markdown)).toBe(markdownConverted)
  })
})
