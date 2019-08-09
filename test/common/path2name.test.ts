import path2name from 'common/functions/path2name'

describe('path2name test', () => {
  test('convert path to shortName', () => {
    const testData = [
      ['/user/aoi.miyazaki', 'aoi.miyazaki'],
      ['/user/aoi.miyazaki/', 'aoi.miyazaki/'],
      ['/user/aoi.miyazaki/dialy/', 'dialy/'],
      ['/user/aoi.miyazaki/dialy/2019/08/09', 'dialy/2019/08/09'],
      ['/user/aoi.miyazaki/dialy/2019/08', 'dialy/2019/08'],
      ['/user/aoi.miyazaki/dialy/2019', 'dialy/2019'],
      ['/user/aoi.miyazaki/dialy/2019/', 'dialy/2019/'],
    ]

    for (const t of testData) {
      expect(path2name(t[0])).toEqual(t[1])
    }
  })
})
