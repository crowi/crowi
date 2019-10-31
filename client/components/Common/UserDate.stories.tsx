import React from 'react'
import UserDate from './UserDate'

export default { title: 'Common/UserDate' }

export const Default = () => <UserDate dateTime="2019-09-28 03:20:01.234" />

export const FromNow = () => <UserDate dateTime="2019-09-28 03:20:01.234" format="fromNow" />
