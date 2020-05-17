import React from 'react'
import Pagination from './Pagination'

export default { title: 'Common/Pagination' }

export const Default = () => <Pagination current={5} count={10} onClick={() => {}} />

export const StartPage = () => <Pagination current={1} count={3} onClick={() => {}} />

export const SmallTotalSize = () => <Pagination current={2} count={3} onClick={() => {}} />

export const SmallTotalSizeLastPage = () => <Pagination current={3} count={3} onClick={() => {}} />

export const AlmostLastPage = () => <Pagination current={9} count={10} onClick={() => {}} />

export const LastPage = () => <Pagination current={10} count={10} onClick={() => {}} />
