const crypto = require('crypto')
const mongodb = require('mongodb')

const chai = ({ expect } = require('chai'))

chai.use(require('sinon-chai'))
chai.use(require('chai-as-promised'))

const { mongoose } = require('../utils.js')

const createTeam = (...users) => {
  const Team = mongoose.model('Team')
  const t = new Team({
    handle: crypto.randomBytes(16).toString('hex'),
    users,
  })
  return t.save()
}
const createPage = user => {
  const Page = mongoose.model('Page')
  const p = new Page({
    path: `/random/${crypto.randomBytes(16)}`,
    grant: Page.GRANT_PUBLIC,
    grantedUsers: [user._id],
    creator: user._id,
  })
  return p.save()
}
const createUser = () => {
  const User = mongoose.model('User')
  const r = crypto.randomBytes(16).toString('hex')
  const u = new User({
    name: r,
    username: r,
    email: r + '@example.com',
  })
  return u.save()
}

describe('PageOwner', () => {
  before(async () => {
    const PageOwner = mongoose.model('PageOwner')
    await PageOwner.collection.drop()
    await PageOwner.ensureIndexes()
  })

  it('MongoDB must prevent duplicate creation', async () => {
    const user = await createUser()
    const page = await createPage(user)
    const team = await createTeam()

    await team.ownPage(page)

    const PageOwner = mongoose.model('PageOwner')

    // ownPage uses findAndUpdate & $setOnInsert, on the theory this situation will not be happened
    const po = new PageOwner({
      page,
      team,
    })
    await expect(po.save())
      .to.eventually.rejectedWith(mongodb.MongoError)
      .have.property('message')
      .include('duplicate key error')
  })
})
