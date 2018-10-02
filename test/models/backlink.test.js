const chai = require('chai')
const expect = chai.expect
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
const faker = require('faker')
const utils = require('../utils.js')
chai.use(sinonChai)

describe('Backlink', () => {
  const Backlink = utils.models.Backlink
  const Page = utils.models.Page
  const Revision = utils.models.Revision
  const conn = utils.mongoose.connection
  const appUrl = 'http://localhost:3000'
  let user

  before(async () => {
    const createdUsers = await testDBUtil.generateFixture(conn, 'User', [
      { name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() },
    ])
    user = createdUsers[0]
  })

  describe('.createByAllPages', () => {
    before(async () => {
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

    it('should have all backlinks', async () => {
      expect(await Backlink.createByAllPages()).to.have.lengthOf(3)
    })
  })
})
