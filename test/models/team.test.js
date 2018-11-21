const crypto = require('crypto')

const utils = require('../utils.js')
const { mongoose } = utils

describe('Team', () => {
  // models will be accessable after global 'before' hook runned (on util.js)
  const { User, Team, Page, PageOwner } = utils.models

  const conn = utils.mongoose.connection
  let users = []

  const createTeam = (...users) => {
    const t = new Team({
      handle: crypto.randomBytes(16).toString('hex'),
      users,
    })
    return t.save()
  }
  const createPage = (path = `/random/${crypto.randomBytes(16)}`) => {
    const user = users[Math.floor(Math.random() * users.length)]
    const p = new Page({
      path,
      grant: Page.GRANT_PUBLIC,
      grantedUsers: [user._id],
      creator: user._id,
    })
    return p.save()
  }

  beforeAll(async () => {
    const userFixture = [
      { name: 'Anon 3', username: 'anonymous3', email: 'anonymous3@example.com' },
      { name: 'Anon 4', username: 'anonymous4', email: 'anonymous4@example.com' },
    ]
    users = await testDBUtil.generateFixture(conn, 'User', userFixture)
  })

  afterAll(async () => {
    await User.remove({})
  })

  afterEach(async () => {
    await Promise.all([
      Team.remove({}),
      Page.remove({
        creator: {
          $in: users.map(user => user._id),
        },
      }),
    ])
  })

  /**
   * class methods
   */

  describe('#findByUser', () => {
    it('Find teams by user collectly', async () => {
      await createTeam(...users)
      const team0 = await createTeam(users[0])
      const team1 = await createTeam(users[1])

      const teamsRelatedTo0 = await Team.findByUser(users[0])
      expect(teamsRelatedTo0).toHaveLength(2)
      // ここらへんの assert うまいことできんかな
      expect(teamsRelatedTo0.map(team => team._id.toString())).toEqual(expect.not.arrayContaining([team1._id.toString()]))

      const teamsRelatedTo1 = await Team.findByUser(users[1])
      expect(teamsRelatedTo1).toHaveLength(2)
      // ここらへんの assert うまいことできんかな
      expect(teamsRelatedTo1.map(team => team._id.toString())).toEqual(expect.not.arrayContaining([team0._id.toString()]))
    })

    it('When missing arguments', async () => {
      await expect(Team.findByUser()).rejects.toThrow(TypeError)
    })
  })

  describe('#findByHandle', () => {
    it('Find the team by handle collectly', async () => {
      const actualTeam = await createTeam()

      const team = await Team.findByHandle(actualTeam.handle)
      expect(team._id.toString()).toBe(actualTeam._id.toString())
    })

    it('When missing arguments', async () => {
      await expect(Team.findByHandle()).rejects.toThrow(TypeError)
    })
  })

  /**
   * instance methods
   */

  // I don't test #addUser and #deleteUser because I will test instance methods that shorthanded its
  describe('.addUser', async () => {
    it('Add users collectly', async () => {
      const team = await createTeam()

      expect(team.users).toHaveLength(0)

      const team1 = await team.addUser(...users)
      expect(team1.users).toHaveLength(2)

      // add same users, no affection
      const team2 = await team.addUser(...users)
      expect(team2.users).toHaveLength(2)
    })

    it('When missing arguments', async () => {
      const team = await createTeam()
      await expect(team.addUser()).rejects.toThrow(TypeError)
    })
  })

  describe('.deleteUser', async () => {
    it('Delete users collectly', async () => {
      const team = await createTeam()

      const team1 = await team.addUser(...users)
      expect(team1.users).toHaveLength(2)

      const team2 = await team1.deleteUser(users[0])
      expect(team2.users).toHaveLength(1)

      // remove same users, no affection
      const team3 = await team1.deleteUser(users[0])
      expect(team3.users).toHaveLength(1)

      const team4 = await team1.deleteUser(users[1])
      expect(team4.users).toHaveLength(0)
    })

    it('When missing arguments', async () => {
      const team = await createTeam()
      await expect(team.deleteUser()).rejects.toThrow(TypeError)
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

  describe('.getPagesOwned', () => {
    it('when no pages owned by team', async () => {
      const team = await createTeam()

      const pages = await team.getPagesOwned()

      expect(pages).toHaveLength(0)
    })
  })

  describe('.ownPage', () => {
    it('When missing arguments', async () => {
      const team = await createTeam()
      await expect(team.ownPage()).rejects.toThrow(TypeError)
    })

    it('Operation must be failed when you try to own userpage', async () => {
      const [team, page] = await Promise.all([createTeam(), createPage('/user/dummy')])
      await expect(team.ownPage(page)).rejects.toThrow(utils.errors.PreconditionError)
    })
  })

  describe('.disownPage', () => {
    it('Operation must be failed when you run disownPage to non owned page', async () => {
      const [team, team2, page] = await Promise.all([createTeam(), createTeam(), createPage()])
      await team2.ownPage(page)

      await expect(team.disownPage(page)).rejects.toThrow(utils.errors.PreconditionError)
    })

    it('When missing arguments', async () => {
      const team = await createTeam()
      await expect(team.disownPage()).rejects.toThrow(TypeError)
    })
  })

  describe('.getPagesOwned, .ownPage, .disownPage', () => {
    it('own and disown some pages', async () => {
      const [team, page] = await Promise.all([createTeam(), createPage()])
      expect(await team.getPagesOwned()).toHaveLength(0)

      await expect(team.ownPage(page)).resolves.toBe(true)
      expect(await team.getPagesOwned()).toHaveLength(1)

      // no effect on same things
      await expect(team.ownPage(page)).resolves.toBe(true)
      expect(await team.getPagesOwned()).toHaveLength(1)

      await expect(team.disownPage(page)).resolves.toBe(true)
      expect(await team.getPagesOwned()).toHaveLength(0)
    })
  })
})
