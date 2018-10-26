const utils = require('../utils.js')

describe('User', () => {
  const Page = utils.models.Page
  const User = utils.models.User
  const conn = utils.mongoose.connection

  describe('Create and Find.', () => {
    describe('The user', () => {
      test('should created', done => {
        User.createUserByEmailAndPassword('Aoi Miyazaki', 'aoi', 'aoi@example.com', 'hogefuga11', 'en', function(err, userData) {
          expect(err).toBeNull()
          expect(userData).toBeInstanceOf(User)
          done()
        })
      })

      test('should be found by findUserByUsername', done => {
        User.findUserByUsername('aoi').then(function(userData) {
          expect(userData).toBeInstanceOf(User)
          done()
        })
      })

      test('should be found by findUsersByPartOfEmail', done => {
        User.findUsersByPartOfEmail('ao', {}).then(function(userData) {
          expect(userData).toBeInstanceOf(Array)
          expect(userData[0]).toBeInstanceOf(User)
          expect(userData[0].email).toBe('aoi@example.com')
          done()
        })
      })
    })
  })

  describe('User Utilities', () => {
    describe('Get username from path', () => {
      test('found', done => {
        var username = null
        username = User.getUsernameByPath('/user/sotarok')
        expect(username).toBe('sotarok')

        username = User.getUsernameByPath('/user/some.user.name12/') // with slash
        expect(username).toBe('some.user.name12')

        done()
      })

      test('not found', done => {
        var username = null
        username = User.getUsernameByPath('/the/page/is/not/related/to/user/page')
        expect(username).toBeNull()

        done()
      })
    })
  })
})
