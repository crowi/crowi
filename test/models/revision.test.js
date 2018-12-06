const moment = require('moment')
const crypto = require('crypto')

const {
  models: { Team, Page, User, Revision },
} = require('../utils')

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

describe('Revision', () => {
  describe('#prepareRevision', () => {
    describe('Check setting expirationAt', () => {
      let user, team

      beforeAll(async () => {
        user = await createUser()
        team = await createTeam(user)
      })

      test('empty', async () => {
        const page = await createPage(user)
        const revision = Revision.prepareRevision(page, '# body', user, {})
        expect(revision.expirationAt).toBe(null)
      })

      test('calc collectly from given page.lifetime', async () => {
        let page = await createPage(user)

        await team.ownPage(page)
        page = await page.populate('owners').execPopulate()

        page = await page.updateLifetime({ days: 5 })

        const m = moment()
          .add(page.lifetime)
          .endOf('day')
        const revision = Revision.prepareRevision(page, '# body', user, {})

        expect(m.diff(revision.expirationAt)).toBe(0)
      })
    })
  })
})
