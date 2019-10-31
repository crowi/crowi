import React from 'react'
import Crowi from 'client/util/Crowi'
import RecentlyViewedPageList from './RecentlyViewedPageList'

const crowi = new Crowi({ user: {}, csrfToken: '' }, window)

export default { title: 'HeaderSearchBox/RecentlyViewedPageList' }

export const Default = () => <RecentlyViewedPageList crowi={crowi} />
