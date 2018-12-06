const utils = require('../utils.js')
const ActivityDefine = require('../../lib/util/activityDefine')()

describe('Watcher', () => {
  const Watcher = utils.models.Watcher
  const mongoose = utils.mongoose
  const ObjectId = mongoose.Types.ObjectId
  const { ACTIONS } = ActivityDefine

  describe('.upsertWatcher', () => {
    test('should create', async () => {
      const userId = ObjectId()
      const targetId = ObjectId()

      try {
        const watcher = await Watcher.upsertWatcher(userId, 'Page', targetId, Watcher.STATUS_WATCH)
        expect(watcher.user.toString()).toBe(userId.toString())
        expect(watcher.targetModel).toBe('Page')
        expect(watcher.target.toString()).toBe(targetId.toString())
        expect(watcher.status).toBe(Watcher.STATUS_WATCH)
      } catch (err) {
        throw new Error(err)
      }
    })
  })

  describe('.getWatcherBrokerDocument', () => {
    it('COMMENT', () => {
      const target = ObjectId()
      expect(Watcher.getWatcherBrokerDocument({ action: ACTIONS.COMMENT, target })).toBe(target)
    })

    it('LIKE', () => {
      const event = ObjectId()
      expect(Watcher.getWatcherBrokerDocument({ action: ACTIONS.LIKE, event })).toBe(event)
    })

    it('MENTION', () => {
      expect(Watcher.getWatcherBrokerDocument({ action: ACTIONS.MENTION })).toBe(null)
    })
  })
})
