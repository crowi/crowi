const faker = require('faker')

describe('Backlink', () => {
  let Backlink
  let Page
  let Revision
  let conn
  const appUrl = 'http://localhost:13001'
  let user

  beforeAll(done => {
    Backlink = crowi.model('Backlink')
    Page = crowi.model('Page')
    Revision = crowi.model('Revision')
    conn = crowi.getMongo().connection

    done()
  })

  beforeAll(async done => {
    const createdUsers = await testDBUtil.generateFixture(conn, 'User', [
      { name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() },
    ])
    user = createdUsers[0]

    done()
  })

  describe('.createByAllPages', () => {
    beforeAll(async () => {
      await Page.remove({})
      await Revision.remove({})
      const createPath = () => '/' + faker.lorem.slug()
      const createPaths = () => [...Array(3)].map(createPath)
      const createPage = (path, body = 'test') => Page.create(path, body, user, {})
      const destPaths = createPaths()
      const srcPaths = createPaths()

      await Promise.all(destPaths.map(path => createPage(path)))
      const pages = await Promise.all([
        createPage(srcPaths[0], `<${destPaths[0]}>`),
        createPage(srcPaths[1], `[test](${appUrl}${destPaths[1]})`),
        createPage(srcPaths[2], `${appUrl}${destPaths[2]}`),
      ])

      await Backlink.remove({})
    })

    test('should have all backlinks', async () => {
      const pages = await Backlink.createByAllPages()
      expect(pages).toHaveLength(3)
    })
  })
})
