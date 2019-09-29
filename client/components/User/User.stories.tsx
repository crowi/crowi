import React from 'react'
import { createUser } from 'client/fixtures'
import User from './User'

export default { title: 'User/User' }

const user = createUser()

export const Default = () => <User user={user} />

export const Name = () => <User user={user} name />

export const Username = () => <User user={user} username />

export const NameAndUsername = () => <User user={user} name username />
