const moment = require('moment')
const crypto = require('crypto')

const {
  models: { Page, User, Revision },
} = require('../utils')

// When required, you can add save
const createPage = user => {
  const p = new Page({
    path: `/random/${crypto.randomBytes(16)}`,
    grant: Page.GRANT_PUBLIC,
    grantedUsers: [user._id],
    creator: user._id,
  })
  return p
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
      let user

      beforeAll(async () => {
        user = await createUser()
      })

      test('empty', () => {
        const page = createPage(user)
        const revision = Revision.prepareRevision(page, '# body', user, {})
        expect(revision.expirationAt).toBe(null)
      })

      test('calc collectly from given page.lifetime', async () => {
        const page = createPage(user)
        const lp = await page.updateLifetime({ days: 5 })

        const m = moment().add(lp.lifetime).endOf('day')
        const revision = Revision.prepareRevision(lp, '# body', user, {})

        expect(m.diff(revision.expirationAt)).toBe(0)
      })
    })
  })
})
