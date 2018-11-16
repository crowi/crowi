const utils = require('../utils.js')

describe('Watcher', function() {
  const Watcher = utils.models.Watcher
  const mongoose = utils.mongoose
  const ObjectId = mongoose.Types.ObjectId

  describe('.upsertWatcher', function() {
    describe('valid parameters', function() {
      it('should create', async function() {
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
  })
})
