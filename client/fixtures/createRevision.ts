import faker from 'faker'
import { createUser } from './'
import { Revision } from 'client/types/crowi'

export const createRevision = (revision: Partial<Revision> = {}): Revision => {
  const {
    _id = faker.random.uuid(),
    path = `/${faker.lorem.slug()}`,
    body = faker.lorem.paragraphs(),
    format = 'markdown',
    author = createUser(),
    createdAt = faker.date.recent(10).toISOString(),
  } = revision

  return { _id, path, body, format, author, createdAt }
}
