import LinkDetector from 'server/util/linkDetector'
import { crowi } from 'server/test/setup'

describe('Url test', () => {
  test('detectInternalLink', () => {
    const linkDetector = LinkDetector(crowi)

    let text = 'aaaaaaaa '
    text += '[/user/suzuki/memo/2017/01/22/aaa](http://localhost:13001/58842b9ccf3556baedce2762)'
    text += ' bbbbb '
    text += '[/user/suzuki/memo/2017/01/22/bbb](http://localhost:13001/58842b9ccf3556baedce2763)'
    text += 'ccccc'
    text += '</user/suzuki/memo/2017/01/22/ccc>'
    text += 'ddd'
    text += '[/user/suzuki/memo/2017/01/22/aaa](http://localhost:13001/58842b9ccf3556baedce2762)'
    text += ' bbbbb '
    text += 'http://localhost:13001/user/suzuki/%E3%83%A1%E3%83%A2/2017/01/31/ddd#aaa'
    text += ' bbbbb '
    text += 'http://localhost:13001/user/suzuki/メモ/2017/02/01/ddd?a=1'
    text += 'ee '
    text += '[/user/suzuki/memo/2017/05/06/eee]'

    const results = linkDetector.search(text)

    expect(results).toHaveProperty('objectIds')
    expect(results.objectIds).toHaveLength(2)
    expect(results.objectIds).toEqual(expect.arrayContaining(['58842b9ccf3556baedce2762', '58842b9ccf3556baedce2763']))

    expect(results).toHaveProperty('paths')
    expect(results.paths).toHaveLength(4)
    expect(results.paths).toEqual(
      expect.arrayContaining([
        '/user/suzuki/memo/2017/01/22/ccc',
        '/user/suzuki/メモ/2017/01/31/ddd',
        '/user/suzuki/メモ/2017/02/01/ddd',
        '/user/suzuki/memo/2017/05/06/eee',
      ]),
    )
  })
})
