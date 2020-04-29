import Slack from 'server/util/slack'
import { crowi } from 'server/test/setup'

describe('Slack Util', () => {
  let slack
  beforeAll(() => {
    slack = Slack(crowi)
  })

  test('convert markdown', () => {
    const markdown = '# ほげほげ\n\n* aaa\n* bbb\n* ccc\n\n## ほげほげほげ\n\n[Yahoo! Japan](http://www.yahoo.co.jp/) is here\n**Bold** and *Italic*'
    const markdownConverted = '\n*ほげほげ*\n\n• aaa\n• bbb\n• ccc\n\n\n*ほげほげほげ*\n\n<http://www.yahoo.co.jp/|Yahoo! Japan> is here\n**Bold** and *Italic*'
    expect(slack.convertMarkdownToMrkdwn(markdown)).toBe(markdownConverted)
  })
})
