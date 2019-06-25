class LRU {
  constructor(crowi) {
    this.crowi = crowi
    this.max = 10
    this.client = null

    if (this.crowi && this.crowi.redis) {
      this.client = this.crowi.redis
    }
  }

  removeByRange(namespace, max) {
    if (this.client) {
      return new Promise((resolve, reject) => {
        this.client.zremrangebyrank(namespace, 0, max, (err, response) => {
          if (err) reject(err)
          resolve(response)
        })
      })
    }
  }

  async add(namespace, key) {
    if (this.client) {
      await this.removeByRange(namespace, -this.max - 1)
      return new Promise((resolve, reject) => {
        this.client.zadd(namespace, Date.now(), key, (err, response) => {
          if (err) reject(err)
          resolve(response)
        })
      })
    }
  }

  range(namespace, limit = 0) {
    if (this.client) {
      return new Promise((resolve, reject) => {
        this.client.zrevrange(namespace, 0, limit - 1, (err, response) => {
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

module.exports = LRU
