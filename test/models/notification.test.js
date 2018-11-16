const utils = require('../utils.js')

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
    describe('valid parameters', function() {
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
            expect(notification.user.toString()).toBe(userId1.toString())
            expect(notification.targetModel).toBe('Page')
            expect(notification.target.toString()).toBe(targetId.toString())
            expect(notification.action).toBe('COMMENT')
            expect(notification.status).toBe(Notification.STATUS_UNREAD)
            expect(notification.activities).toHaveLength(3)
          })
          .catch(function(err) {
            throw new Error(err)
          })
      })
    })

    describe('invalid parameters', function() {
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
            expect(err.message).toBe('Validation failed')
          },
        )
      })
    })
  })

  describe('.read', () => {
    describe('read', () => {
      const user = ObjectId()
      let notificationId

      beforeAll(async () => {
        await Notification.remove({})
        const target = ObjectId()
        const sameActivityUsers = [ObjectId(), ObjectId()]
        const activity = { user, targetModel: 'Page', target, action: 'COMMENT' }
        const notification = await Notification.upsertByActivity(user, sameActivityUsers, activity)
        notificationId = notification._id
      })

      it('status is changed correctly', async () => {
        const result = await Notification.read(user)
        expect(result).toEqual({ n: 1, nModified: 1, ok: 1 })
      })
    })
  })

  describe('.open', () => {
    describe('open', () => {
      const user = ObjectId()
      let notificationId

      beforeAll(async () => {
        await Notification.remove({})
        const target = ObjectId()
        const sameActivityUsers = [ObjectId(), ObjectId()]
        const activity = { user, targetModel: 'Page', target, action: 'COMMENT' }
        const notification = await Notification.upsertByActivity(user, sameActivityUsers, activity)
        notificationId = notification._id
      })

      it('status is changed correctly', async () => {
        const notification = await Notification.open({ _id: user }, notificationId)
        expect(notification.status).toBe(Notification.STATUS_OPENED)
      })
    })
  })

  describe('.getUnreadCountByUser', () => {
    const user = ObjectId()

    describe('initially', () => {
      beforeAll(async () => {
        await Notification.remove({})
      })

      it('is zero', async () => {
        const count = await Notification.getUnreadCountByUser(user)
        expect(count).toBe(0)
      })
    })

    describe('after created', () => {
      beforeAll(async () => {
        const target = ObjectId()
        const sameActivityUsers = [ObjectId(), ObjectId()]
        const activity = { user, targetModel: 'Page', target, action: 'COMMENT' }
        await Notification.upsertByActivity(user, sameActivityUsers, activity)
      })

      it('is count correctly', async () => {
        const count = await Notification.getUnreadCountByUser(user)
        expect(count).toBe(1)
      })
    })
  })
})
