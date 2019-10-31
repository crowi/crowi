import React, { useState } from 'react'
import SearchToolbar from './SearchToolbar'

export default { title: 'SearchPage/SearchToolbar' }

export const Default = () => {
  const [defaultType, setDefaultType] = useState('')

  return <SearchToolbar keyword="crowi" type={defaultType} total={100} changeType={setDefaultType} searching={false} />
}

export const Searching = () => {
  const [searchingType, setSearchingType] = useState('')

  return <SearchToolbar keyword="crowi" type={searchingType} total={undefined} changeType={setSearchingType} searching />
}
