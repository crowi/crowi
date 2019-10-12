import faker from 'faker'
import { User } from 'client/types/crowi'

export const createUser = (user: Partial<User> = {}): User => {
  const { _id = faker.random.uuid(), image = '', name = faker.name.findName(), username = faker.internet.userName() } = user

  return { _id, image, name, username }
}
