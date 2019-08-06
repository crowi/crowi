import Crowi from 'server/crowi'
import { RedisClient } from 'redis'

export default class LRU {
  crowi: Crowi

  max: number

  client: RedisClient | null

  constructor(crowi: Crowi) {
    this.crowi = crowi
    this.max = 10
    this.client = null

    if (this.crowi && this.crowi.redis) {
      this.client = this.crowi.redis
    }
  }

  removeByRange(namespace, max) {
    const { client } = this

    if (client) {
      return new Promise((resolve, reject) => {
        client.zremrangebyrank(namespace, 0, max, (err, response) => {
          if (err) reject(err)
          resolve(response)
        })
      })
    }
  }

  async add(namespace, key) {
    const { client } = this

    if (client) {
      await this.removeByRange(namespace, -this.max - 1)
      return new Promise((resolve, reject) => {
        client.zadd(namespace, Date.now(), key, (err, response) => {
          if (err) reject(err)
          resolve(response)
        })
      })
    }
  }

  range(namespace, limit = 0) {
    const { client } = this

    if (client) {
      return new Promise((resolve, reject) => {
        client.zrevrange(namespace, 0, limit - 1, (err, response) => {
          if (err) reject(err)
          resolve(response)
        })
      })
    }
  }

  get(namespace, limit) {
    if (this.client) {
      return this.range(namespace, limit)
    }
  }
}
