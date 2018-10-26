const utils = require('../utils.js')

describe('Page', () => {
  const Page = utils.models.Page
  const User = utils.models.User
  const conn = utils.mongoose.connection
  let createdPages
  let createdUsers

  beforeAll(done => {
    Promise.resolve()
      .then(() => {
        const userFixture = [
          { name: 'Anon 0', username: 'anonymous0', email: 'anonymous0@example.com' },
          { name: 'Anon 1', username: 'anonymous1', email: 'anonymous1@example.com' },
        ]

        return testDBUtil.generateFixture(conn, 'User', userFixture)
      })
      .then(testUsers => {
        createdUsers = testUsers
        const testUser0 = testUsers[0]

        const fixture = [
          {
            path: '/user/anonymous/memo',
            grant: Page.GRANT_RESTRICTED,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/public',
            grant: Page.GRANT_PUBLIC,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/restricted',
            grant: Page.GRANT_RESTRICTED,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/specified',
            grant: Page.GRANT_SPECIFIED,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/grant/owner',
            grant: Page.GRANT_OWNER,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
          {
            path: '/page/for/extended',
            grant: Page.GRANT_PUBLIC,
            creator: testUser0,
            extended: { hoge: 1 },
          },
        ]

        return testDBUtil.generateFixture(conn, 'Page', fixture).then(pages => {
          createdPages = pages
          done()
        })
      })
  })

  describe('.isPublic', () => {
    describe('with a public page', () => {
      test('should return true', done => {
        Page.findOne({ path: '/grant/public' }, (err, page) => {
          expect(err).toBeNull()
          expect(page.isPublic()).toBe(true)
          done()
        })
      })
    })
    ;['restricted', 'specified', 'owner'].forEach(grant => {
      describe('with a ' + grant + ' page', () => {
        test('should return false', done => {
          Page.findOne({ path: '/grant/' + grant }, (err, page) => {
            expect(err).toBeNull()
            expect(page.isPublic()).toBe(false)
            done()
          })
        })
      })
    })
  })

  describe('.getDeletedPageName', () => {
    test('should return trash page name', () => {
      expect(Page.getDeletedPageName('/hoge')).toBe('/trash/hoge')
      expect(Page.getDeletedPageName('hoge')).toBe('/trash/hoge')
    })
  })
  describe('.getRevertDeletedPageName', () => {
    test('should return reverted trash page name', () => {
      expect(Page.getRevertDeletedPageName('/hoge')).toBe('/hoge')
      expect(Page.getRevertDeletedPageName('/trash/hoge')).toBe('/hoge')
      expect(Page.getRevertDeletedPageName('/trash/hoge/trash')).toBe('/hoge/trash')
    })
  })

  describe('.isDeletableName', () => {
    test('should decide deletable or not', () => {
      expect(Page.isDeletableName('/hoge')).toBe(true)
      expect(Page.isDeletableName('/user/xxx')).toBe(false)
      expect(Page.isDeletableName('/user/xxx123')).toBe(false)
      expect(Page.isDeletableName('/user/xxx/')).toBe(true)
      expect(Page.isDeletableName('/user/xxx/hoge')).toBe(true)
    })
  })

  describe('.isCreatableName', () => {
    test('should decide creatable or not', () => {
      expect(Page.isCreatableName('/hoge')).toBe(true)

      // edge cases
      expect(Page.isCreatableName('/me')).toBe(false)
      expect(Page.isCreatableName('/me/')).toBe(false)
      expect(Page.isCreatableName('/me/x')).toBe(false)
      expect(Page.isCreatableName('/meeting')).toBe(true)
      expect(Page.isCreatableName('/meeting/x')).toBe(true)

      // end with "edit"
      expect(Page.isCreatableName('/meeting/edit')).toBe(false)

      // under score
      expect(Page.isCreatableName('/_')).toBe(false)
      expect(Page.isCreatableName('/_r/x')).toBe(false)
      expect(Page.isCreatableName('/_api')).toBe(false)
      expect(Page.isCreatableName('/_apix')).toBe(false)
      expect(Page.isCreatableName('/_api/x')).toBe(false)

      expect(Page.isCreatableName('/hoge/xx.md')).toBe(false)

      // start with https?
      expect(Page.isCreatableName('/http://demo.crowi.wiki/user/sotarok/hoge')).toBe(false)
      expect(Page.isCreatableName('/https://demo.crowi.wiki/user/sotarok/hoge')).toBe(false)
      expect(Page.isCreatableName('http://demo.crowi.wiki/user/sotarok/hoge')).toBe(false)
      expect(Page.isCreatableName('https://demo.crowi.wiki/user/sotarok/hoge')).toBe(false)

      expect(Page.isCreatableName('/ the / path / with / space')).toBe(false)

      let forbidden = []
      forbidden = ['installer', 'register', 'login', 'logout', 'admin', 'files', 'trash', 'paste', 'comments']
      for (var i = 0; i < forbidden.length; i++) {
        const pn = forbidden[i]
        expect(Page.isCreatableName('/' + pn + '')).toBe(false)
        expect(Page.isCreatableName('/' + pn + '/')).toBe(false)
        expect(Page.isCreatableName('/' + pn + '/abc')).toBe(false)
      }

      forbidden = ['bookmarks', 'comments', 'activities', 'pages', 'recent-create', 'recent-edit']
      for (var i = 0; i < forbidden.length; i++) {
        const pn = forbidden[i]
        expect(Page.isCreatableName('/user/aoi/' + pn)).toBe(false)
        expect(Page.isCreatableName('/user/aoi/x/' + pn)).toBe(true)
      }
    })
  })

  describe('.isCreator', () => {
    describe('with creator', () => {
      test('should return true', done => {
        User.findOne({ email: 'anonymous0@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/user/anonymous/memo' }, (err, page) => {
            expect(page.isCreator(user)).toBe(true)
            done()
          })
        })
      })
    })

    describe('with non-creator', () => {
      test('should return false', done => {
        User.findOne({ email: 'anonymous1@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/user/anonymous/memo' }, (err, page) => {
            expect(page.isCreator(user)).toBe(false)
            done()
          })
        })
      })
    })
  })

  describe('.isGrantedFor', () => {
    describe('with a granted user', () => {
      test('should return true', done => {
        User.findOne({ email: 'anonymous0@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/user/anonymous/memo' }, (err, page) => {
            if (err) {
              done(err)
            }

            expect(page.isGrantedFor(user)).toBe(true)
            done()
          })
        })
      })
    })

    describe('with a public page', () => {
      test('should return true', done => {
        User.findOne({ email: 'anonymous1@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/grant/public' }, (err, page) => {
            if (err) {
              done(err)
            }

            expect(page.isGrantedFor(user)).toBe(true)
            done()
          })
        })
      })
    })

    describe('with a restricted page and an user who has no grant', () => {
      test('should return false', done => {
        User.findOne({ email: 'anonymous1@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/grant/restricted' }, (err, page) => {
            if (err) {
              done(err)
            }

            expect(page.isGrantedFor(user)).toBe(false)
            done()
          })
        })
      })
    })
  })

  describe('Extended field', () => {
    describe('Slack Channel.', () => {
      test('should be empty', done => {
        Page.findOne({ path: '/page/for/extended' }, (err, page) => {
          expect(page.extended.hoge).toBe(1)
          expect(page.getSlackChannel()).toBe('')
          done()
        })
      })

      test('set slack channel and should get it and should keep hoge ', done => {
        Page.findOne({ path: '/page/for/extended' }, (err, page) => {
          page.updateSlackChannel('slack-channel1').then(data => {
            Page.findOne({ path: '/page/for/extended' }, (err, page) => {
              expect(page.extended.hoge).toBe(1)
              expect(page.getSlackChannel()).toBe('slack-channel1')
              done()
            })
          })
        })
      })
    })
  })

  describe('Normalize path', () => {
    describe('Normalize', () => {
      test('should start with slash', done => {
        expect(Page.normalizePath('hoge/fuga')).toBe('/hoge/fuga')
        done()
      })

      test('should trim spaces of slash', done => {
        expect(Page.normalizePath('/ hoge / fuga')).toBe('/hoge/fuga')
        done()
      })
    })
  })

  describe('.findPage', () => {
    describe('findPageById', () => {
      test('should find page', done => {
        const pageToFind = createdPages[0]
        Page.findPageById(pageToFind._id).then(pageData => {
          expect(pageData.path).toBe(pageToFind.path)
          done()
        })
      })
    })

    describe('findPageByIdAndGrantedUser', () => {
      test('should find page', done => {
        const pageToFind = createdPages[0]
        const grantedUser = createdUsers[0]
        Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser).then(pageData => {
          expect(pageData.path).toBe(pageToFind.path)
          done()
        })
      })

      test('should error by grant', done => {
        const pageToFind = createdPages[0]
        const grantedUser = createdUsers[1]
        Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser)
          .then(pageData => {
            done(new Error())
          })
          .catch(err => {
            expect(err).toBeInstanceOf(Error)
            done()
          })
      })
    })
  })

  describe('Rename Tree', () => {
    let user

    const generatePages = paths => {
      const grant = Page.GRANT_PUBLIC
      const grantedUsers = [user]
      const creator = user
      return paths.map(path => ({ path, grant, grantedUsers, creator }))
    }

    beforeAll(async () => {
      user = createdUsers[0]
      await Page.remove({})
    })

    describe('A page already exists in the destination', () => {
      beforeEach(async () => {
        const paths = ['/jp/hoge', '/us/hoge/huga', '/jp/hoge/huga']
        await testDBUtil.generateFixture(conn, 'Page', generatePages(paths))
      })

      describe('checkPagesRenamable', () => {
        test('should return error', async () => {
          const paths = await Page.findChildrenByPath('/jp/hoge', user, {})
          const pathMap = Page.getPathMap(paths, 'jp', 'us')
          const [error] = await Page.checkPagesRenamable(Object.values(pathMap), user)
          expect(error).toBe(true)
        })
      })

      afterEach(async () => Page.remove({}))
    })

    describe('The number of pages is greater than 50', () => {
      let treeSize
      beforeEach(async () => {
        await Page.remove({})
        const children = Array.from(new Array(50).keys()).map(v => `/parent/${v}`)
        const paths = ['/parent', ...children]
        treeSize = paths.length
        await testDBUtil.generateFixture(conn, 'Page', generatePages(paths))
      })

      describe('findChildrenByPath', () => {
        test('should fetch a parent page and all children pages (more than 50 pages)', async () => {
          const pages = await Page.findChildrenByPath('/parent', user, {})
          expect(pages).toHaveLength(treeSize)
        })
      })

      afterEach(async () => Page.remove({}))
    })

    describe('The name of the tree starts with the name of another tree', () => {
      beforeEach(async () => {
        await Page.remove({})
        const paths = ['/car', '/car/ambulance', '/car/minicar', '/car/taxi', '/carrot']
        await testDBUtil.generateFixture(conn, 'Page', generatePages(paths))
      })

      describe('findChildrenByPath', () => {
        test('should not contain other trees', async () => {
          const pages = await Page.findChildrenByPath('/car', user, {})
          expect(pages).toBeInstanceOf(Array)
          expect(pages.some(page => page.path === '/carrot')).toBe(false)
        })
      })

      afterEach(async () => Page.remove({}))
    })
  })
})
