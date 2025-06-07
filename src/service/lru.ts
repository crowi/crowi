import Crowi from 'src/crowi'
import { RedisClientType } from 'redis'

export default class LRU {
  crowi: Crowi

  max: number

  client: any

  constructor(crowi: Crowi) {
    this.crowi = crowi
    this.max = 10
    this.client = null

    if (this.crowi && this.crowi.redis) {
      this.client = this.crowi.redis
    }
  }

  async removeByRange(namespace, max) {
    const { client } = this

    if (client) {
      return await client.zRemRangeByRank(namespace, 0, max)
    }
  }

  async add(namespace, key) {
    const { client } = this

    if (client) {
      await this.removeByRange(namespace, -this.max - 1)
      return await client.zAdd(namespace, { score: Date.now(), value: key })
    }
  }

  async range(namespace, limit = 0) {
    const { client } = this

    if (client) {
      return await client.zRange(namespace, 0, limit - 1, { REV: true })
    }
  }

  get(namespace, limit) {
    if (this.client) {
      return this.range(namespace, limit)
    }
  }
}
