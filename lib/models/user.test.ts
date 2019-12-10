import { crowi } from 'server/test/setup'

describe('User', () => {
  let Page
  let User

  beforeAll(() => {
    Page = crowi.model('Page')
    User = crowi.model('User')
  })

  describe('Create and Find.', () => {
    describe('The user', () => {
      test('should created', () => {
        return new Promise(resolve => {
          User.createUserByEmailAndPassword('Aoi Miyazaki', 'aoi', 'aoi@example.com', 'hogefuga11', 'en', function(err, userData) {
            expect(err).toBeNull()
            expect(userData).toBeInstanceOf(User)
            resolve()
          })
        })
      })

      test('should be found by findUserByUsername', () => {
        return new Promise(resolve => {
          User.findUserByUsername('aoi').then(function(userData) {
            expect(userData).toBeInstanceOf(User)
            resolve()
          })
        })
      })

      test('should be found by findUsersByPartOfEmail', () => {
        return new Promise(resolve => {
          User.findUsersByPartOfEmail('ao', {}).then(function(userData) {
            expect(userData[0]).toBeInstanceOf(User)
            expect(userData[0].email).toBe('aoi@example.com')
            resolve()
          })
        })
      })
    })
  })

  describe('User Utilities', () => {
    describe('Get username from path', () => {
      test('found', () => {
        return new Promise(resolve => {
          let username = null
          username = User.getUsernameByPath('/user/sotarok')
          expect(username).toBe('sotarok')

          username = User.getUsernameByPath('/user/some.user.name12/') // with slash
          expect(username).toBe('some.user.name12')

          resolve()
        })
      })

      test('not found', () => {
        return new Promise(resolve => {
          let username = null
          username = User.getUsernameByPath('/the/page/is/not/related/to/user/page')
          expect(username).toBeNull()

          resolve()
        })
      })
    })
  })
})
