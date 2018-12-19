const crypto = require('crypto')

const utils = require('../utils.js')
const { mongoose } = utils

describe('Team', () => {
  // models will be accessable after global 'before' hook runned (on util.js)
  const { User, Team, Page, PageOwner } = utils.models

  const conn = mongoose.connection
  let createdUsers = []

  const createTeam = (...users) => {
    return Team.create({
      handle: crypto.randomBytes(16).toString('hex'),
      users,
    })
  }
  const createPage = ({ path = `/random/${crypto.randomBytes(16)}`, user = null } = {}) => {
    const p = new Page({
      path,
      grant: Page.GRANT_PUBLIC,
      grantedUsers: user ? [user._id] : createdUsers.map(user => user._id),
      creator: user || createdUsers[Math.floor(createdUsers.length * Math.random())],
    })
    return p.save()
  }

  beforeAll(async () => {
    const userFixture = [
      { name: 'Anon 3', username: 'anonymous3', email: 'anonymous3@example.com' },
      { name: 'Anon 4', username: 'anonymous4', email: 'anonymous4@example.com' },
    ]
    createdUsers = await testDBUtil.generateFixture(conn, 'User', userFixture)
  })

  afterAll(async () => {
    await User.remove({})
  })

  afterEach(async () => {
    await Promise.all([
      ...createdUsers.map(u => Team.findByUser(u).remove()),
      Page.remove({
        creator: {
          $in: createdUsers.map(user => user._id),
        },
      }),
    ])
  })

  /**
   * class methods
   */

  describe('#findByUser', () => {
    it('Find teams by user collectly', async () => {
      await createTeam(...createdUsers)
      const team0 = await createTeam(createdUsers[0])
      const team1 = await createTeam(createdUsers[1])

      const teamsRelatedTo0 = await Team.findByUser(createdUsers[0])
      expect(teamsRelatedTo0).toHaveLength(2)
      // ここらへんの assert うまいことできんかな
      expect(teamsRelatedTo0.map(team => team._id.toString())).toEqual(expect.not.arrayContaining([team1._id.toString()]))

      const teamsRelatedTo1 = await Team.findByUser(createdUsers[1])
      expect(teamsRelatedTo1).toHaveLength(2)
      // ここらへんの assert うまいことできんかな
      expect(teamsRelatedTo1.map(team => team._id.toString())).toEqual(expect.not.arrayContaining([team0._id.toString()]))
    })

    it('When missing arguments', () => {
      expect(() => Team.findByUser()).toThrow(TypeError)
    })
  })

  describe('#findByHandle', () => {
    it('Find the team by handle collectly', async () => {
      const actualTeam = await createTeam(...createdUsers)

      const team = await Team.findByHandle(actualTeam.handle)
      expect(team._id.toString()).toBe(actualTeam._id.toString())
    })

    it('When missing arguments', () => {
      expect(() => Team.findByHandle()).toThrow(TypeError)
    })
  })

  /**
   * instance methods
   */

  describe('create & edit', async () => {
    it('Add users collectly', async () => {
      const team = await createTeam(createdUsers[0])
      expect((await Team.findById(team)).users).toHaveLength(1)

      // edit users
      const team1 = await team.edit({ users: createdUsers })
      expect((await Team.findById(team)).users).toHaveLength(createdUsers.length)

      // edit name
      const team2 = await team1.edit({ name: 'The good humans' })
      expect((await Team.findById(team)).name).toBe('The good humans')

      // without edit, return as is
      expect(await team2.edit()).toBe(team2)
    })

    it('When someone create/edit with 0 users, it will be fail.', async () => {
      await expect(
        createTeam().catch(e => {
          throw e.errors.users
        }),
      ).rejects.toThrow()
      const team = await createTeam(createdUsers[0])
      await expect(
        team.edit({ users: [] }).catch(e => {
          throw e.errors.users
        }),
      ).rejects.toThrow()
    })
  })

  describe('.save', () => {
    it('when invalid "handle" given', async () => {
      const team = new Team({
        handle: '$ggg^',
      })

      await expect(team.save())
        .rejects // be rejected
        .toHaveProperty('errors.handle') // mongoose's ValidationError have detail for each field

      await expect(
        team.save().catch(e => {
          throw e.errors.handle
        }),
      ).rejects.toThrow('handle must be')
    })
  })

  describe('Query methods', () => {
    it('populateAll', async () => {
      const team = await createTeam(...createdUsers)
      const page = await createPage()
      await expect(PageOwner.activate({ team, page })).resolves.toBeTruthy()

      const t = await Team.findByHandle(team.handle).populateAll()

      // populateUsers
      expect(t.users).toHaveLength(createdUsers.length)
      t.users.forEach(user => {
        const fu = createdUsers.filter(cu => cu._id.equals(user._id))
        expect(fu).toHaveLength(1)
      })

      // populatePageOwners
      expect(t.pageOwners).toHaveLength(1)
      expect(t.pageOwners[0].page._id.equals(page._id)).toBeTruthy()
    })
  })
})
