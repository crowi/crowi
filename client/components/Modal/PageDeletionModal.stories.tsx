import React from 'react'
import PageDeletionModal from './PageDeletionModal'
import Crowi from '../../utils/Crowi'
import { createAppContext } from 'client/fixtures/createAppContext'
import { Button } from 'reactstrap'

const appContext = createAppContext({ path: '/foo/bar' })
const crowi = new Crowi(appContext, window)
const pageId = null
const revisionId = null

export default { title: 'Modal/PageDeletionModal' }

export const Default = () => (
  <>
    <Button color="primary" data-target="#deletePage">
      Open Modal
    </Button>
    <PageDeletionModal crowi={crowi} pageId={pageId} revisionId={revisionId} />
  </>
)
