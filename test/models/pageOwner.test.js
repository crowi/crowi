const crypto = require('crypto')
const mongodb = require('mongodb')

const { models, errors } = require('../utils.js')
const { Team, Page, User, PageOwner } = models

const createTeam = (...users) => {
  const t = new Team({
    handle: crypto.randomBytes(16).toString('hex'),
    users,
  })
  return t.save()
}
const createPage = ({ path = `/random/${crypto.randomBytes(16)}`, user } = {}) => {
  const p = new Page({
    path,
    grant: Page.GRANT_PUBLIC,
    grantedUsers: [user._id],
    creator: user._id,
  })
  return p.save()
}
const createUser = () => {
  const r = crypto.randomBytes(16).toString('hex')
  const u = new User({
    name: r,
    username: r,
    email: r + '@example.com',
  })
  return u.save()
}

describe('PageOwner', () => {
  it('MongoDB must prevent duplicate creation', async () => {
    const user = await createUser()
    const page = await createPage({ user })
    const team = await createTeam()

    await team.ownPage(page)

    // ownPage uses findAndUpdate & $setOnInsert, on the theory this situation will not be happened
    const po = new PageOwner({
      page,
      team,
    })
    await expect(po.save()).rejects.toThrow('duplicate key error')
  })

  describe('activate', () => {
    it('When missing arguments', async () => {
      const team = await createTeam()
      await expect(PageOwner.activate({ team })).rejects.toThrow(TypeError)
    })

    it('Operation must be failed when you try to own userpage', async () => {
      const user = await createUser()
      const [team, page] = await Promise.all([createTeam(), createPage({ path: '/user/dummy', user })])
      await expect(PageOwner.activate({ team, page })).rejects.toThrow(errors.PreconditionError)
    })
  })

  describe('activate & deactivate, findByPageAndTeam', () => {
    it('own and disown some pages', async () => {
      const user = await createUser()
      const [team, page] = await Promise.all([createTeam(), createPage({ user })])
      expect(await PageOwner.findByTeam(team)).toHaveLength(0)

      await expect(PageOwner.activate({ team, page })).resolves.toBeTruthy()
      expect(await PageOwner.findByTeam(team)).toHaveLength(1)

      // no effect on same things
      await expect(PageOwner.activate({ team, page })).resolves.toBeTruthy()
      expect(await PageOwner.findByTeam(team)).toHaveLength(1)

      const po = await PageOwner.findByPageAndTeam({ team, page })

      const deactivatedPO = await po.deactivate()
      await expect(deactivatedPO.isActive).toBe(false)
      expect(await PageOwner.findByTeam(team)).toHaveLength(0)
    })
  })
})
