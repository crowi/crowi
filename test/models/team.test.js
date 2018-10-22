const chai = require('chai')
const expect = chai.expect
const sinonChai = require('sinon-chai')
const utils = require('../utils.js')
chai.use(sinonChai)

const crypto = require('crypto')

describe('Page', () => {
  const { User, Team } = utils.models
  const conn = utils.mongoose.connection
  let users = []
  let team = null

  const createTeam = (...users) => {
    const t = new Team({
      handle: crypto.randomBytes(16).toString('hex'),
      users,
    })
    return t.save()
  }

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

  afterEach(async () => {
    await Team.remove({})
  })

  it('.addUser, .deleteUser', async () => {
    const team = await createTeam()

    const team1 = await team.addUser(...users)
    expect(team1.users).lengthOf(2)

    const team2 = await team1.deleteUser(users[0])
    expect(team2.users).lengthOf(1)
    const team3 = await team1.deleteUser(users[0])
    expect(team3.users).lengthOf(1)

    const team4 = await team1.deleteUser(users[1])
    expect(team4.users).lengthOf(0)
  })

  it('#findByUser', async () => {
    await createTeam(...users)
    const team0 = await createTeam(users[0])
    const team1 = await createTeam(users[1])

    const teamsRelatedTo0 = await Team.findByUser(users[0])
    expect(teamsRelatedTo0).lengthOf(2)
    // ここらへんの assert うまいことできんかな
    expect(teamsRelatedTo0.map(team => team._id.toString())).that.does.not.include(team1.toString())

    const teamsRelatedTo1 = await Team.findByUser(users[1])
    expect(teamsRelatedTo1).lengthOf(2)
    // ここらへんの assert うまいことできんかな
    expect(teamsRelatedTo1.map(team => team._id.toString())).that.does.not.include(team0.toString())
  })

  it('#findOneByHandle', async () => {
    const actualTeam = await createTeam()

    const team = await Team.findOneByHandle(actualTeam.handle)
    expect(team._id.toString()).to.be.equal(actualTeam._id.toString())
  })

  describe('.save', () => {
    it('when invalid "handle" given', async () => {
      const team = new Team({
        handle: '$ggg^',
      })
      const e = await team.save().catch(e => e)

      expect(e).to.be.instanceOf(Error)
      expect(e.errors.handle).to.be.instanceOf(Error)
      expect(e.errors.handle.message).to.include('handle must be') // custom message
    })
  })
})
