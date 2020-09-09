import faker from 'faker'
import { createRevision, createUser } from './'
import { Page } from 'client/types/crowi'

export const createPage = (page: Partial<Page> = {}): Page => {
  const defaultPath = `/${faker.lorem.slug()}`
  const {
    _id = faker.random.uuid(),
    path = defaultPath,
    revision = createRevision({ path: defaultPath }),
    redirectTo = '',
    status = '',
    creator = createUser(),
    lastUpdateUser = createUser(),
    liker = [],
    seenUsers = [],
    commentCount = 0,
    bookmarkCount = 0,
    createdAt = new Date(),
    updatedAt = new Date(),
  } = page

  return { _id, path, revision, redirectTo, status, creator, lastUpdateUser, liker, seenUsers, commentCount, bookmarkCount, createdAt, updatedAt }
}
