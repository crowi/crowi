const chai = require('chai')

const expect = chai.expect

const sinon = require('sinon')

const sinonChai = require('sinon-chai')

const faker = require('faker')

const utils = require('../utils.js')
chai.use(sinonChai)

describe('Activity', function() {
  const Activity = utils.models.Activity
  const User = utils.models.User
  const Page = utils.models.Page
  const Comment = utils.models.Comment
  const Watcher = utils.models.Watcher
  const mongoose = utils.mongoose
  const conn = utils.mongoose.connection
  const ObjectId = mongoose.Types.ObjectId

  describe('.createByParameters', function() {
    context('correct parameters', function() {
      it('should create', function() {
        const userId = ObjectId()
        const targetId = ObjectId()

        const parameters = {
          user: userId,
          targetModel: 'Page',
          target: targetId,
          action: 'COMMENT',
        }

        return Activity.createByParameters(parameters).then(
          function(activity) {
            expect(activity.user).to.be.equal(userId)
            expect(activity.target).to.be.equal(targetId)
            expect(activity.targetModel).to.be.equal('Page')
            expect(activity.action).to.be.equal('COMMENT')
          },
          function(err) {
            throw new Error(err)
          },
        )
      })
    })

    context('invalid parameters', function() {
      it('should not create', function() {
        const userId = ObjectId()
        const targetId = ObjectId()

        const parameters = {
          user: userId,
          targetModel: 'Page2', // validation error
          target: targetId,
          action: 'COMMENT',
        }

        return Activity.createByParameters(parameters).then(
          function(activity) {
            throw new Error('not fulfilled')
          },
          function(err) {
            expect(err.message).to.be.equal('Activity validation failed')
          },
        )
      })
    })
  })

  describe('.removeByParameters', () => {
    context('correct parameters', () => {
      const user = ObjectId()
      const target = ObjectId()
      const parameters = { user, targetModel: 'Page', target, action: 'COMMENT' }

      before(async () => {
        await Activity.createByParameters(parameters)
      })

      it('should remove', async () => {
        const { result } = await Activity.removeByParameters(parameters)
        expect(result).to.deep.equal({ n: 1, ok: 1 })
      })
    })
  })

  describe('Target users', () => {
    const userIds = [ObjectId(), ObjectId(), ObjectId()]
    const pageId = ObjectId()
    const activityId = ObjectId()

    before(async () => {
      await Promise.all([User, Page, Comment, Watcher, Activity].map(model => model.remove({})))

      const users = [
        { _id: userIds[0], email: faker.internet.email(), status: User.STATUS_ACTIVE },
        { _id: userIds[1], email: faker.internet.email(), status: User.STATUS_ACTIVE },
        { _id: userIds[2], email: faker.internet.email(), status: User.STATUS_SUSPENDED },
      ]
      const pages = [{ _id: pageId, path: `/${faker.lorem.word()}`, grant: Page.GRANT_PUBLIC, creator: userIds[0] }]
      const comments = userIds.map(userId => ({ page: pageId, creator: userId, comment: faker.lorem.word() }))

      await testDBUtil.generateFixture(conn, 'User', users)
      await testDBUtil.generateFixture(conn, 'Page', pages)
      await testDBUtil.generateFixture(conn, 'Comment', comments)
    })

    afterEach(async () => {
      await Promise.all([Watcher, Activity].map(model => model.remove({})))
    })

    context('Action User and Suspended User', () => {
      let notificationUsers
      before(async () => {
        const activity = await Activity.createByParameters({ user: userIds[0], target: pageId, targetModel: 'Page', action: 'COMMENT' })
        notificationUsers = (await activity.getNotificationTargetUsers()).map(String)
      })

      it('is not contain action user', () => {
        expect(notificationUsers).to.not.include(String(userIds[0]))
      })

      it('is not contain suspended user', () => {
        expect(notificationUsers).to.not.include(String(userIds[2]))
      })
    })

    context('Watch', () => {
      before(async () => {
        await Watcher.watchByPageId(userIds[1], pageId, Watcher.STATUS_WATCH)
      })

      it('is watched', async () => {
        const activity = await Activity.createByParameters({ user: userIds[0], target: pageId, targetModel: 'Page', action: 'COMMENT' })
        const notificationUsers = (await activity.getNotificationTargetUsers()).map(String)

        expect(notificationUsers).to.include(String(userIds[1]))
      })
    })

    context('Ignore', () => {
      before(async () => {
        await Watcher.watchByPageId(userIds[1], pageId, Watcher.STATUS_IGNORE)
      })

      it('is ignored', async () => {
        const activity = await Activity.createByParameters({ user: userIds[0], target: pageId, targetModel: 'Page', action: 'COMMENT' })
        const notificationUsers = (await activity.getNotificationTargetUsers()).map(String)

        expect(notificationUsers).to.not.include(String(userIds[1]))
      })
    })
  })
})
