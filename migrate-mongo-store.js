/**
 * Crowi::migrateStore
 *
 * @package Crowi
 * @author  otofune <otofune@gmail.com>
 */

const mongoose = require('mongoose')

const crowi = new (require('./lib/crowi'))(__dirname, process.env)

const migrationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    unique: true,
  },
  at: {
    type: Date,
    required: true,
    index: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['up', 'down'],
  },
  history: [
    {
      status: {
        type: String,
        required: true,
        enum: ['up', 'down'],
      },
      at: {
        type: Date,
        required: true,
      },
    },
  ],
})
migrationSchema.methods.toEntry = function() {
  return {
    title: this.title,
    timestamp: this.status === 'up' ? this.at.getTime() : null,
  }
}
migrationSchema.statics.updateByEntry = function(entry) {
  const { title, timestamp: at = Date.now() } = entry
  const status = parseInt(entry.timestamp, 10) > 0 ? 'up' : 'down'

  return this.findOneAndUpdate(
    { title: entry.title },
    {
      $set: {
        at,
        status,
      },
      $push: {
        history: {
          status,
          at,
        },
      },
      $setOnInsert: {
        title,
      },
    },
    { new: true, upsert: true },
  )
}
const Migration = mongoose.model('Migrations', migrationSchema)

module.exports = class MongoStore {
  constructor() {
    this.ready = false
    this.migrations = null
  }

  async init() {
    if (this.ready) return
    // connect to database with crowi's configuration
    await crowi.setupDatabase()
    this.ready = true
  }

  async save(store, cb) {
    try {
      await this.init()
      /**
       * Clone to prevent race condition from tj/migrate inmemory store.
       * 実行時 up/down 毎に save を呼び出すのだが、その中の migrations に入っている
       *  Migrate モデルがあり、これをおそらくインスタンス再利用して更新している
       * この関数では保存判定ロジックとして、既存で持っている store と見比べるのだが
       *  その保存処理を安全のために保存後に行っており、またクローンしていなかったので
       *  書き込まれるかが不安定であった
       */
      const entries = store.migrations.filter(m => !(m.title in this.migrations) || this.migrations[m.title].timestamp !== m.timestamp).map(e => ({
        title: e.title,
        timestamp: e.timestamp,
      }))

      await Promise.all(entries.map(m => Migration.updateByEntry(m)))
      this.migrations = entries.reduce((o, c) => {
        o[c.title] = { ...c }
        return o
      }, {})

      cb(null)
    } catch (e) {
      cb(e)
    }
  }

  async load(cb) {
    try {
      await this.init()
      const migrations = await Migration.find().sort({ at: -1 })
      const entries = migrations.map(m => m.toEntry())

      const store = {
        lastRun: migrations.find(m => m.status === 'up' && m.title),
        migrations: entries,
      }

      this.migrations = entries.reduce((o, c) => {
        o[c.title] = { ...c }
        return o
      }, {})

      return cb(null, store)
    } catch (e) {
      cb(e)
    }
  }
}
