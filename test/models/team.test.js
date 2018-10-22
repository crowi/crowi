const chai = require('chai')
const expect = chai.expect
const sinonChai = require('sinon-chai')
const utils = require('../utils.js')
chai.use(sinonChai)

const { ObjectId } = require('mongoose').Schema.Types

describe('Page', () => {
  const { User, Team } = utils.models
  const conn = utils.mongoose.connection
  let users = []
  let team = null

  before(async () => {
    const userFixture = [
      { name: 'Anon 3', username: 'anonymous3', email: 'anonymous3@example.com' },
      { name: 'Anon 4', username: 'anonymous4', email: 'anonymous4@example.com' },
    ]
    users = await testDBUtil.generateFixture(conn, 'User', userFixture)
  })

  after(async () => {
    await User.remove({})
  })

  beforeEach(async () => {
    const t = new Team({
      handle: 'anon',
      users: []
    })
    team = await t.save()
  })

  afterEach(async () => {
    await team.remove()
  })

  describe('#addUser, #deleteUser', () => {
    it('mixed', async () => {
      const team1 = await team.addUser(...users)
      expect(team1.users.length).to.be.equal(2)

      const team2 = await team1.deleteUser(users[0])
      expect(team2.users.length).to.be.equal(1)
      const team3 = await team1.deleteUser(users[0])
      expect(team3.users.length).to.be.equal(1)

      const team4 = await team1.deleteUser(users[1])
      expect(team4.users.length).to.be.equal(0)
    })
  })
})
