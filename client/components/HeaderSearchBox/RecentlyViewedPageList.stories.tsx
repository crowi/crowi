import React from 'react'
import Crowi from 'client/util/Crowi'
import RecentlyViewedPageList from './RecentlyViewedPageList'
import { createAppContext } from 'client/fixtures/createAppContext'

const appContext = createAppContext()

const crowi = new Crowi(appContext, window)

export default { title: 'HeaderSearchBox/RecentlyViewedPageList' }

export const Default = () => <RecentlyViewedPageList crowi={crowi} />
