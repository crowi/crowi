import faker from 'faker'
import { crowi, Fixture } from 'server/test/setup'

describe('Share', () => {
  let User
  let Page
  let Share
  let user
  let createdPages

  beforeAll(async () => {
    User = crowi.model('User')
    Page = crowi.model('Page')
    Share = crowi.model('Share')

    await User.deleteMany({})
    const createdUsers = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }])
    user = createdUsers[0]

    await Page.deleteMany({})
    createdPages = await Fixture.generate('Page', [
      { path: '/' + faker.lorem.slug(), grant: Page.GRANT_PUBLIC, grantedUsers: [user], creator: user },
      { path: '/' + faker.lorem.slug(), grant: Page.GRANT_PUBLIC, grantedUsers: [user], creator: user },
    ])

    await Share.deleteMany({})
  })

  afterEach(async () => {
    await Share.deleteMany({})
  })

  describe('.create', () => {
    describe('Create shares', () => {
      test('should be able to create only one active share per page', async () => {
        await expect(Share.createShare(createdPages[0]._id, user)).resolves.toBeInstanceOf(Share)
        await expect(Share.createShare(createdPages[0]._id, user)).rejects.toThrow()
      })
    })
  })

  describe('.delete', () => {
    describe('Delete share', () => {
      let createdShares
      beforeAll(async () => {
        createdShares = [await Share.createShare(createdPages[0]._id, user), await Share.createShare(createdPages[1]._id, user)]
      })

      test('should inactivate share', async () => {
        const shareId = createdShares[0]._id
        await expect(Share.deleteById(shareId)).resolves.toHaveProperty('status', Share.STATUS_INACTIVE)
        const pageId = createdShares[1].page
        await expect(Share.deleteByPageId(pageId)).resolves.toHaveProperty('status', Share.STATUS_INACTIVE)
      })
    })
  })
})
