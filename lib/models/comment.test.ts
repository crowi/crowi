import mongoose from 'mongoose'
import { crowi, Fixture } from 'server/test/setup'

describe('Comment', () => {
  let Page
  let User
  let Comment
  let createdPages
  let createdUsers
  let createdComment

  beforeAll(async () => {
    Page = crowi.model('Page')
    User = crowi.model('User')
    Comment = crowi.model('Comment')

    const userFixture = [
      { name: 'Anon 0', username: 'anonymous0', email: 'anonymous0@example.com' },
      { name: 'Anon 1', username: 'anonymous1', email: 'anonymous1@example.com' },
    ]

    const testUsers = await Fixture.generate('User', userFixture)
    createdUsers = testUsers
    const testUser0 = testUsers[0]

    const fixture = [
      {
        path: '/grant/public',
        grant: Page.GRANT_PUBLIC,
        grantedUsers: [testUser0],
        creator: testUser0,
      },
    ]

    createdPages = await Fixture.generate('Page', fixture)
  })

  describe('Comment.create', () => {
    test('should be created', async () => {
      const page = await Page.findOne({ path: '/grant/public' })
      const creator = await User.findUserByUsername('anonymous1')
      const revision = undefined
      const comment = 'これがテスト用のコメント'
      const commentPosition = undefined

      createdComment = await Comment.create({ page, creator, revision, comment, commentPosition })
      try {
        const createdCommentBody = createdComment.comment
        expect(createdCommentBody).toBe('これがテスト用のコメント')
      } catch (err) {
        throw new Error(err)
      }
    })
  })

  describe('Comment.removeCommentById', () => {
    test('should be deleted', async () => {
      try {
        let comments = await Comment.countCommentByPageId(createdComment.page.id)
        expect(comments).toStrictEqual(1)
        await Comment.removeCommentById(createdComment._id)
        comments = await Comment.countCommentByPageId(createdComment.page.id)
        expect(comments).toStrictEqual(0)
      } catch (err) {
        throw new Error(err)
      }
    })
  })
})
