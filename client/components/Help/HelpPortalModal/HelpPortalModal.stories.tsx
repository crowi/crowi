import React from 'react'
import HelpPortalModal from './HelpPortalModal'
import { Button } from 'reactstrap'

export default { title: 'Help/HelpPortalModal/HelpPortalModal' }

export const Default = () => (
  <>
    <Button color="primary" data-target="#help-portal">
      Open Modal
    </Button>
    <HelpPortalModal />
  </>
)
