const faker = require('faker')
const utils = require('../utils.js')

describe('Mention', () => {
  const Mention = utils.models.Mention
  const User = utils.models.User
  const Page = utils.models.Page
  const Revision = utils.models.Revision
  const mongoose = utils.mongoose
  const conn = utils.mongoose.connection
  const ObjectId = mongoose.Types.ObjectId

  let users
  beforeAll(async () => {
    await User.remove({})
    const userFixture = [
      { name: faker.name.findName(), username: 'hoge', email: faker.internet.email() },
      { name: faker.name.findName(), username: 'huga', email: faker.internet.email() },
      { name: faker.name.findName(), username: 'piyo', email: faker.internet.email() },
    ]
    users = await testDBUtil.generateFixture(conn, 'User', userFixture)
  })

  const createPage = async body => {
    await Page.remove({})

    const user = users[0]
    const newPage = new Page({ path: `/${faker.lorem.slug()}`, creator: user })
    await newPage.save()

    const newRevision = Revision.prepareRevision(newPage, body, user)
    return Page.pushRevision(newPage, newRevision, user)
  }

  const toContainObject = object => expect.arrayContaining([expect.objectContaining(object)])

  describe('.upsertByPage', () => {
    describe('Equivalent mention', () => {
      it('should create', async () => {
        const body = '@huga\n@huga'
        const page = await createPage(body)
        const mentions = await Mention.upsertByPage(page)

        expect(mentions).toHaveLength(1)
        expect(mentions).toEqual(toContainObject({ user: users[1]._id }))
      })
    })

    describe('Multiple mentions', () => {
      it('should create', async () => {
        const body = '@huga\n@piyo'
        const page = await createPage(body)
        const mentions = await Mention.upsertByPage(page)

        expect(mentions).toHaveLength(2)
        expect(mentions).toEqual(toContainObject({ user: users[1]._id }))
        expect(mentions).toEqual(toContainObject({ user: users[2]._id }))
      })
    })
  })
})
