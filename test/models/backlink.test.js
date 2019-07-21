const faker = require('faker')

describe('Backlink', () => {
  const Backlink = crowi.model('Backlink')
  const Page = crowi.model('Page')
  const Revision = crowi.model('Revision')
  const conn = crowi.getMongo().connection
  const appUrl = 'http://localhost:3000'
  let user

  beforeAll(async () => {
    const createdUsers = await testDBUtil.generateFixture(conn, 'User', [
      { name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() },
    ])
    user = createdUsers[0]
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
      await Promise.all([
        createPage(srcPaths[0], `<${destPaths[0]}>`),
        createPage(srcPaths[1], `[test](${appUrl}${destPaths[1]})`),
        createPage(srcPaths[2], `${appUrl}${destPaths[2]}`),
      ])
      await Backlink.remove({})
    })

    test('should have all backlinks', async () => {
      expect(await Backlink.createByAllPages()).toHaveLength(3)
    })
  })
})
