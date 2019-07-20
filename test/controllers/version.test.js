const utils = require('../utils.js')

describe('Config model test', () => {
  const Page = utils.models.Page
  const Config = utils.models.Config
  const User = utils.models.User
  const conn = utils.mongoose.connection

  beforeAll(function(done) {
    /*
    const fixture = [
      { ns: 'crowi', key: 'test:test', value: JSON.stringify('crowi test value') },
      { ns: 'crowi', key: 'test:test2', value: JSON.stringify(11111) },
      { ns: 'crowi', key: 'test:test3', value: JSON.stringify([1, 2, 3, 4, 5]) },
      { ns: 'plugin', key: 'other:config', value: JSON.stringify('this is data') },
    ]

    testDBUtil
      .generateFixture(conn, 'Config', fixture)
      .then(function(configs) {
        done()
      })
      .catch(function() {
        done(new Error('Skip this test.'))
      })
      */
    done()
  })

  describe('/_api/versions.get', () => {
    test('1', () => {
      expect(1).toBe(1)
    })
  })

  /*
  describe('.loadAllConfig', () => {
    test('Get config array', async function() {
      const config = await Config.loadAllConfig()
      expect(config.crowi).toBeInstanceOf(Object)
      expect(config.crowi).toHaveProperty('test:test', 'crowi test value')
      expect(config.crowi).toHaveProperty('test:test2', 11111)
      expect(config.crowi).toHaveProperty('test:test3', [1, 2, 3, 4, 5])

      expect(config.plugin).toBeInstanceOf(Object)
      expect(config.plugin).toHaveProperty('other:config', 'this is data')
    })
  })
  */
})
