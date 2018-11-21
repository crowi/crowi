const crypto = require('crypto')
const mongodb = require('mongodb')

const { models } = require('../utils.js')
const { Team, Page, User, PageOwner } = models

const createTeam = (...users) => {
  const t = new Team({
    handle: crypto.randomBytes(16).toString('hex'),
    users,
  })
  return t.save()
}
const createPage = user => {
  const p = new Page({
    path: `/random/${crypto.randomBytes(16)}`,
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
    const page = await createPage(user)
    const team = await createTeam()

    await team.ownPage(page)

    // ownPage uses findAndUpdate & $setOnInsert, on the theory this situation will not be happened
    const po = new PageOwner({
      page,
      team,
    })
    await expect(po.save()).rejects.toThrow('duplicate key error')
  })
})
