var chai = require('chai')

var expect = chai.expect

var sinon = require('sinon')

var sinonChai = require('sinon-chai')

var utils = require('../utils.js')
chai.use(sinonChai)

describe('Notification', function() {
  const Comment = utils.models.Comment
  const Notification = utils.models.Notification
  const Page = utils.models.Page
  const User = utils.models.User
  const Activity = utils.models.Activity
  const mongoose = utils.mongoose
  const ObjectId = mongoose.Types.ObjectId
  const conn = utils.mongoose.connection

  const data = {}

  describe('.upsertByActivity', function() {
    context('valid parameters', function() {
      it('should create', function() {
        const userId1 = ObjectId()
        const userId2 = ObjectId()
        const userId3 = ObjectId()

        const targetId = ObjectId()

        const sameActivityUsers = [userId1, userId2, userId3]

        const activity = {
          user: userId1,
          targetModel: 'Page',
          target: targetId,
          action: 'COMMENT',
        }

        return Notification.upsertByActivity(userId1, sameActivityUsers, activity)
          .then(function(notification) {
            expect(notification.user.toString()).to.be.equal(userId1.toString())
            expect(notification.targetModel).to.be.equal('Page')
            expect(notification.target.toString()).to.be.equal(targetId.toString())
            expect(notification.action).to.be.equal('COMMENT')
            expect(notification.status).to.be.equal(Notification.STATUS_UNREAD)
            expect(notification.activities).to.be.length(3)
          })
          .catch(function(err) {
            throw new Error(err)
          })
      })
    })

    context('invalid parameters', function() {
      it('should create', function() {
        const userId1 = ObjectId()
        const userId2 = ObjectId()
        const userId3 = ObjectId()

        const targetId = ObjectId()

        const sameActivityUsers = [userId1, userId2, userId3]

        const activity = {
          user: userId1,
          targetModel: 'Page2', // invalid
          target: targetId,
          action: 'COMMENT',
        }

        return Notification.upsertByActivity(userId1, sameActivityUsers, activity).then(
          function(notification) {
            throw new Error('validation not work')
          },
          function(err) {
            expect(err.message === 'Notification validation failed')
          },
        )
      })
    })
  })

  describe('.read', () => {
    context('read', () => {
      const user = ObjectId()
      let notificationId

      before(async () => {
        await Notification.remove({})
        const target = ObjectId()
        const sameActivityUsers = [ObjectId(), ObjectId()]
        const activity = { user, targetModel: 'Page', target, action: 'COMMENT' }
        const notification = await Notification.upsertByActivity(user, sameActivityUsers, activity)
        notificationId = notification._id
      })

      it('status is changed correctly', async () => {
        const result = await Notification.read(user)
        expect(result).to.be.deep.equal({ n: 1, nModified: 1, ok: 1 })
      })
    })
  })

  describe('.open', () => {
    context('open', () => {
      const user = ObjectId()
      let notificationId

      before(async () => {
        await Notification.remove({})
        const target = ObjectId()
        const sameActivityUsers = [ObjectId(), ObjectId()]
        const activity = { user, targetModel: 'Page', target, action: 'COMMENT' }
        const notification = await Notification.upsertByActivity(user, sameActivityUsers, activity)
        notificationId = notification._id
      })

      it('status is changed correctly', async () => {
        const notification = await Notification.open({ _id: user }, notificationId)
        expect(notification.status).to.be.equal(Notification.STATUS_OPENED)
      })
    })
  })

  describe('.getUnreadCountByUser', () => {
    const user = ObjectId()

    context('initially', () => {
      before(async () => {
        await Notification.remove({})
      })

      it('is zero', async () => {
        const count = await Notification.getUnreadCountByUser(user)
        expect(count).to.be.equal(0)
      })
    })

    context('after created', () => {
      before(async () => {
        const target = ObjectId()
        const sameActivityUsers = [ObjectId(), ObjectId()]
        const activity = { user, targetModel: 'Page', target, action: 'COMMENT' }
        await Notification.upsertByActivity(user, sameActivityUsers, activity)
      })

      it('is count correctly', async () => {
        const count = await Notification.getUnreadCountByUser(user)
        expect(count).to.be.equal(1)
      })
    })
  })
})
