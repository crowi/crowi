describe('Watcher', function() {
  const Watcher = crowi.model('Watcher')
  const mongoose = crowi.getMongo()
  const ObjectId = mongoose.Types.ObjectId

  describe('.upsertWatcher', () => {
    describe('valid parameters', () => {
      it('should create', async () => {
        const userId = ObjectId()
        const targetId = ObjectId()

        console.log('targetId', targetId, targetId.constructor.name)

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
