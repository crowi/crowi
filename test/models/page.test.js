var chai = require('chai')
var expect = chai.expect
var sinon = require('sinon')
var sinonChai = require('sinon-chai')
var utils = require('../utils.js')
chai.use(sinonChai)

describe('Page', () => {
  var Page = utils.models.Page
  var User = utils.models.User
  var conn = utils.mongoose.connection
  var createdPages
  var createdUsers

  before(done => {
    Promise.resolve()
      .then(() => {
        var userFixture = [
          { name: 'Anon 0', username: 'anonymous0', email: 'anonymous0@example.com' },
          { name: 'Anon 1', username: 'anonymous1', email: 'anonymous1@example.com' },
        ]

        return testDBUtil.generateFixture(conn, 'User', userFixture)
      })
      .then(testUsers => {
        createdUsers = testUsers
        var testUser0 = testUsers[0]

        var fixture = [
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
    context('with a public page', () => {
      it('should return true', done => {
        Page.findOne({ path: '/grant/public' }, (err, page) => {
          expect(err).to.be.null
          expect(page.isPublic()).to.be.equal(true)
          done()
        })
      })
    })
    ;['restricted', 'specified', 'owner'].forEach(grant => {
      context('with a ' + grant + ' page', () => {
        it('should return false', done => {
          Page.findOne({ path: '/grant/' + grant }, (err, page) => {
            expect(err).to.be.null
            expect(page.isPublic()).to.be.equal(false)
            done()
          })
        })
      })
    })
  })

  describe('.getDeletedPageName', () => {
    it('should return trash page name', () => {
      expect(Page.getDeletedPageName('/hoge')).to.be.equal('/trash/hoge')
      expect(Page.getDeletedPageName('hoge')).to.be.equal('/trash/hoge')
    })
  })
  describe('.getRevertDeletedPageName', () => {
    it('should return reverted trash page name', () => {
      expect(Page.getRevertDeletedPageName('/hoge')).to.be.equal('/hoge')
      expect(Page.getRevertDeletedPageName('/trash/hoge')).to.be.equal('/hoge')
      expect(Page.getRevertDeletedPageName('/trash/hoge/trash')).to.be.equal('/hoge/trash')
    })
  })

  describe('.isDeletableName', () => {
    it('should decide deletable or not', () => {
      expect(Page.isDeletableName('/hoge')).to.be.true
      expect(Page.isDeletableName('/user/xxx')).to.be.false
      expect(Page.isDeletableName('/user/xxx123')).to.be.false
      expect(Page.isDeletableName('/user/xxx/')).to.be.true
      expect(Page.isDeletableName('/user/xxx/hoge')).to.be.true
    })
  })

  describe('.isCreatableName', () => {
    it('should decide creatable or not', () => {
      expect(Page.isCreatableName('/hoge')).to.be.true

      // edge cases
      expect(Page.isCreatableName('/me')).to.be.false
      expect(Page.isCreatableName('/me/')).to.be.false
      expect(Page.isCreatableName('/me/x')).to.be.false
      expect(Page.isCreatableName('/meeting')).to.be.true
      expect(Page.isCreatableName('/meeting/x')).to.be.true

      // end with "edit"
      expect(Page.isCreatableName('/meeting/edit')).to.be.false

      // under score
      expect(Page.isCreatableName('/_')).to.be.false
      expect(Page.isCreatableName('/_r/x')).to.be.false
      expect(Page.isCreatableName('/_api')).to.be.false
      expect(Page.isCreatableName('/_apix')).to.be.false
      expect(Page.isCreatableName('/_api/x')).to.be.false

      expect(Page.isCreatableName('/hoge/xx.md')).to.be.false

      // start with https?
      expect(Page.isCreatableName('/http://demo.crowi.wiki/user/sotarok/hoge')).to.be.false
      expect(Page.isCreatableName('/https://demo.crowi.wiki/user/sotarok/hoge')).to.be.false
      expect(Page.isCreatableName('http://demo.crowi.wiki/user/sotarok/hoge')).to.be.false
      expect(Page.isCreatableName('https://demo.crowi.wiki/user/sotarok/hoge')).to.be.false

      expect(Page.isCreatableName('/ the / path / with / space')).to.be.false

      var forbidden = ['installer', 'register', 'login', 'logout', 'admin', 'files', 'trash', 'paste', 'comments']
      for (var i = 0; i < forbidden.length; i++) {
        var pn = forbidden[i]
        expect(Page.isCreatableName('/' + pn + '')).to.be.false
        expect(Page.isCreatableName('/' + pn + '/')).to.be.false
        expect(Page.isCreatableName('/' + pn + '/abc')).to.be.false
      }

      var forbidden = ['bookmarks', 'comments', 'activities', 'pages', 'recent-create', 'recent-edit']
      for (var i = 0; i < forbidden.length; i++) {
        var pn = forbidden[i]
        expect(Page.isCreatableName('/user/aoi/' + pn)).to.be.false
        expect(Page.isCreatableName('/user/aoi/x/' + pn)).to.be.true
      }
    })
  })

  describe('.isCreator', () => {
    context('with creator', () => {
      it('should return true', done => {
        User.findOne({ email: 'anonymous0@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/user/anonymous/memo' }, (err, page) => {
            expect(page.isCreator(user)).to.be.equal(true)
            done()
          })
        })
      })
    })

    context('with non-creator', () => {
      it('should return false', done => {
        User.findOne({ email: 'anonymous1@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/user/anonymous/memo' }, (err, page) => {
            expect(page.isCreator(user)).to.be.equal(false)
            done()
          })
        })
      })
    })
  })

  describe('.isGrantedFor', () => {
    context('with a granted user', () => {
      it('should return true', done => {
        User.findOne({ email: 'anonymous0@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/user/anonymous/memo' }, (err, page) => {
            if (err) {
              done(err)
            }

            expect(page.isGrantedFor(user)).to.be.equal(true)
            done()
          })
        })
      })
    })

    context('with a public page', () => {
      it('should return true', done => {
        User.findOne({ email: 'anonymous1@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/grant/public' }, (err, page) => {
            if (err) {
              done(err)
            }

            expect(page.isGrantedFor(user)).to.be.equal(true)
            done()
          })
        })
      })
    })

    context('with a restricted page and an user who has no grant', () => {
      it('should return false', done => {
        User.findOne({ email: 'anonymous1@example.com' }, (err, user) => {
          if (err) {
            done(err)
          }

          Page.findOne({ path: '/grant/restricted' }, (err, page) => {
            if (err) {
              done(err)
            }

            expect(page.isGrantedFor(user)).to.be.equal(false)
            done()
          })
        })
      })
    })
  })

  describe('Extended field', () => {
    context('Slack Channel.', () => {
      it('should be empty', done => {
        Page.findOne({ path: '/page/for/extended' }, (err, page) => {
          expect(page.extended.hoge).to.be.equal(1)
          expect(page.getSlackChannel()).to.be.equal('')
          done()
        })
      })

      it('set slack channel and should get it and should keep hoge ', done => {
        Page.findOne({ path: '/page/for/extended' }, (err, page) => {
          page.updateSlackChannel('slack-channel1').then(data => {
            Page.findOne({ path: '/page/for/extended' }, (err, page) => {
              expect(page.extended.hoge).to.be.equal(1)
              expect(page.getSlackChannel()).to.be.equal('slack-channel1')
              done()
            })
          })
        })
      })
    })
  })

  describe('Normalize path', () => {
    context('Normalize', () => {
      it('should start with slash', done => {
        expect(Page.normalizePath('hoge/fuga')).to.equal('/hoge/fuga')
        done()
      })

      it('should trim spaces of slash', done => {
        expect(Page.normalizePath('/ hoge / fuga')).to.equal('/hoge/fuga')
        done()
      })
    })
  })

  describe('.findPage', () => {
    context('findPageById', () => {
      it('should find page', done => {
        const pageToFind = createdPages[0]
        Page.findPageById(pageToFind._id).then(pageData => {
          expect(pageData.path).to.equal(pageToFind.path)
          done()
        })
      })
    })

    context('findPageByIdAndGrantedUser', () => {
      it('should find page', done => {
        const pageToFind = createdPages[0]
        const grantedUser = createdUsers[0]
        Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser).then(pageData => {
          expect(pageData.path).to.equal(pageToFind.path)
          done()
        })
      })

      it('should error by grant', done => {
        const pageToFind = createdPages[0]
        const grantedUser = createdUsers[1]
        Page.findPageByIdAndGrantedUser(pageToFind._id, grantedUser)
          .then(pageData => {
            done(new Error())
          })
          .catch(err => {
            expect(err).to.instanceof(Error)
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

    before(async () => {
      user = createdUsers[0]
      await Page.remove({})
    })

    context('A page already exists in the destination', () => {
      beforeEach(async () => {
        const paths = ['/jp/hoge', '/us/hoge/huga', '/jp/hoge/huga']
        await testDBUtil.generateFixture(conn, 'Page', generatePages(paths))
      })

      describe('checkPagesRenamable', () => {
        it('should return error', async () => {
          const paths = await Page.findChildrenByPath('/jp/hoge', user, {})
          const pathMap = Page.getPathMap(paths, 'jp', 'us')
          const [error] = await Page.checkPagesRenamable(Object.values(pathMap), user)
          expect(error).to.be.equal(true)
        })
      })

      afterEach(async () => Page.remove({}))
    })

    context('The number of pages is greater than 50', () => {
      let treeSize
      beforeEach(async () => {
        await Page.remove({})
        const children = Array.from(new Array(50).keys()).map(v => `/parent/${v}`)
        const paths = ['/parent', ...children]
        treeSize = paths.length
        await testDBUtil.generateFixture(conn, 'Page', generatePages(paths))
      })

      describe('findChildrenByPath', () => {
        it('should fetch a parent page and all children pages (more than 50 pages)', async () => {
          const pages = await Page.findChildrenByPath('/parent', user, {})
          expect(pages.length).to.be.equal(treeSize)
        })
      })

      afterEach(async () => Page.remove({}))
    })

    context('The name of the tree starts with the name of another tree', () => {
      beforeEach(async () => {
        await Page.remove({})
        const paths = ['/car', '/car/ambulance', '/car/minicar', '/car/taxi', '/carrot']
        await testDBUtil.generateFixture(conn, 'Page', generatePages(paths))
      })

      describe('findChildrenByPath', () => {
        it('should not contain other trees', async () => {
          const pages = await Page.findChildrenByPath('/car', user, {})
          expect(pages).to.instanceof(Array)
          expect(pages.some(page => page.path === '/carrot')).to.be.equal(false)
        })
      })

      afterEach(async () => Page.remove({}))
    })
  })
})
