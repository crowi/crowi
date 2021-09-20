import mongoose from 'mongoose'
import { crowi } from 'server/test/setup'
import { WatcherStatus } from './watcher'

describe('Watcher', function () {
  let Watcher
  const ObjectId = mongoose.Types.ObjectId

  beforeAll(() => {
    Watcher = crowi.model('Watcher')
  })

  describe('.upsertWatcher', () => {
    describe('valid parameters', () => {
      it('should create', async () => {
        const userId = ObjectId()
        const targetId = ObjectId()

        try {
          const watcher = await Watcher.upsertWatcher(userId, 'Page', targetId, WatcherStatus.Watch)
          expect(watcher.user.toString()).toBe(userId.toString())
          expect(watcher.targetModel).toBe('Page')
          expect(watcher.target.toString()).toBe(targetId.toString())
          expect(watcher.status).toBe(WatcherStatus.Watch)
        } catch (err) {
          throw new Error(err)
        }
      })
    })
  })
})
