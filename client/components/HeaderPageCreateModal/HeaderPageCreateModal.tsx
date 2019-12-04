import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from 'reactstrap'
import styled from 'styled-components'

import Crowi from 'client/util/Crowi'
import Icon from 'components/Common/Icon'
import PageCreateModal from 'components/Modal/PageCreateModal'

const NewIcon = styled(Icon)`
  margin-right: 3px;
`

const NewButton = styled(Button)`
  height: 38px;
`

interface Props {
  crowi: Crowi
}

const HeaderPageCreateModal: FC<Props> = ({ crowi }) => {
  const [t] = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  const toggle = () => {
    setIsOpen(!isOpen)
  }

  return (
    <>
      <NewButton onClick={toggle} color="primary">
        <NewIcon name="pencilOutline" />
        {t('New')}
      </NewButton>
      <PageCreateModal crowi={crowi} isOpen={isOpen} toggle={toggle} />
    </>
  )
}

export default HeaderPageCreateModal
