const faker = require('faker')
const utils = require('../utils.js')

describe('Share', () => {
  const User = utils.models.User
  const Page = utils.models.Page
  const Share = utils.models.Share
  const conn = utils.mongoose.connection
  let user
  let createdPages

  beforeAll(async () => {
    await User.remove({})
    const createdUsers = await testDBUtil.generateFixture(conn, 'User', [
      { name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() },
    ])
    user = createdUsers[0]

    await Page.remove({})
    createdPages = await testDBUtil.generateFixture(conn, 'Page', [
      { path: '/' + faker.lorem.slug(), grant: Page.GRANT_PUBLIC, grantedUsers: [user], creator: user },
      { path: '/' + faker.lorem.slug(), grant: Page.GRANT_PUBLIC, grantedUsers: [user], creator: user },
    ])

    await Share.remove({})
  })

  afterEach(async () => {
    await Share.remove({})
  })

  describe('.create', () => {
    describe('Create shares', () => {
      test('should be able to create only one active share per page', async () => {
        await expect(Share.create(createdPages[0]._id, user)).resolves.toBeInstanceOf(Share)
        await expect(Share.create(createdPages[0]._id, user)).rejects.toBeInstanceOf(Error)
      })
    })
  })

  describe('.delete', () => {
    describe('Delete share', () => {
      let createdShares
      beforeAll(async () => {
        createdShares = [await Share.create(createdPages[0]._id, user), await Share.create(createdPages[1]._id, user)]
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
