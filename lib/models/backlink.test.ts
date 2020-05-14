import faker from 'faker'
import { crowi, Fixture } from 'server/test/setup'

describe('Backlink', () => {
  let Backlink
  let Page
  let Revision
  let user

  beforeAll(() => {
    Backlink = crowi.model('Backlink')
    Page = crowi.model('Page')
    Revision = crowi.model('Revision')
  })

  beforeAll(async () => {
    const createdUsers = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }])
    user = createdUsers[0]
  })

  describe('.createByAllPages', () => {
    beforeAll(async () => {
      await Page.deleteMany({})
      await Revision.deleteMany({})
      const createPath = () => '/' + faker.lorem.slug()
      const createPaths = () => [...Array(3)].map(createPath)
      const createPage = (path, body = 'test') => Page.createPage(path, body, user, {})
      const destPaths = createPaths()
      const srcPaths = createPaths()
      const appUrl = crowi.baseUrl

      await Promise.all(destPaths.map((path) => createPage(path)))
      const pages = await Promise.all([
        createPage(srcPaths[0], `<${destPaths[0]}>`),
        createPage(srcPaths[1], `[test](${appUrl}${destPaths[1]})`),
        createPage(srcPaths[2], `${appUrl}${destPaths[2]}`),
      ])

      await Backlink.deleteMany({})
    })

    test('should have all backlinks', async () => {
      const pages = await Backlink.createByAllPages()
      expect(pages).toHaveLength(3)
    })
  })
})
