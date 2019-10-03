import React, { useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Form, Input, Label, Modal, ModalBody, ModalHeader } from 'reactstrap'
import moment from 'moment'
import styled from 'styled-components'

import { dark, gray, light } from '../../constants/colors'
import Crowi from 'client/util/Crowi'
import Icon from '../Common/Icon'

const parentPath = (path: string) => {
  if (path === '/') {
    return path
  }

  if (path.match(/.+\/$/)) {
    return path
  }

  return path + '/'
}

interface Props {
  crowi: Crowi
}

const PageCreationModal: FC<Props> = ({ crowi }) => {
  const { user } = crowi
  const currentPath = location.pathname
  const userPath = `/user/${user && user.name}/`
  const datePath = moment(Date.now()).format('/YYYY/MM/DD/')
  const isTopPage = currentPath === '/'

  const [t] = useTranslation()
  const [isOpen, setIsOpen] = useState<boolean>(false)
  const [portalName, setPotalName] = useState<string>(t('Memo'))
  const [pageName, setPageName] = useState<string>('')
  const [underTreePath, setUnderTreePath] = useState<string>(parentPath(currentPath))

  const createTodayPage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const href = `${userPath}${portalName || t('Memo')}${pageName ? datePath : datePath.slice(0, -1)}${pageName}`
    top.location.href = href
  }

  const createUnderTreePage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    top.location.href = underTreePath
  }

  const toggle = () => {
    setIsOpen(!isOpen)
  }

  return (
    <>
      <NewButton onClick={toggle}>
        <NewIcon name="pencilOutline" />
        {t('New')}
      </NewButton>
      <Modal isOpen={isOpen} fade={false} toggle={toggle}>
        <ModalHeader toggle={toggle}>{t('New Page')}</ModalHeader>
        <ModalBody>
          <FormLabel>{t("Create today's")}</FormLabel>
          <Form onSubmit={createTodayPage} inline>
            <TodayInputBox>
              <Path>{userPath}</Path>
              <PortalNameInput type="text" value={portalName} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPotalName(event.target.value)} />
              <Path>{datePath}</Path>
              <PageNameInput
                type="text"
                value={pageName}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPageName(event.target.value)}
                placeholder={t('Page name (optional)')}
              />
            </TodayInputBox>
            <CreateButton>{t('Create')}</CreateButton>
          </Form>
          {!isTopPage && (
            <>
              <hr />
              <FormLabel>{t('Create under', parentPath(currentPath))}</FormLabel>
              <Form onSubmit={createUnderTreePage} inline>
                <UnderTreePathInput
                  type="text"
                  value={underTreePath}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => setUnderTreePath(event.target.value)}
                  placeholder={t('Input page name')}
                />
                <CreateButton>{t('Create')}</CreateButton>
              </Form>
            </>
          )}
        </ModalBody>
      </Modal>
    </>
  )
}

const NewIcon = styled(Icon)`
  margin-right: 3px;
`

const TodayInputBox = styled.div`
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  width: 100%;
`

const BaseInput = styled(Input)`
  background-color: ${light};
  border: none;
  border-bottom: 1px dotted ${dark};
  border-radius: 0;
  font-size: 0.9rem;
  padding: 6px;
  &:focus {
    background-color: ${gray[200]};
    border-color: #7faaaf;
    box-shadow: 0 0 0 0.2rem rgba(67, 103, 107, 0.25);
  }
`

const BaseButton = styled(Button)`
  background-color: #43676b;
  border-color: #43676b;
  font-size: 0.9rem;
  height: 35px;
  &:active {
    background-color: #2f494c;
    border-color: #2a4144;
  }
  &:focus {
    box-shadow: 0 0 0 0.2rem rgba(95, 126, 129, 0.5);
  }
  &:hover {
    background-color: #345053;
  }
`

const NewButton = styled(BaseButton)`
  height: 38px;
`

const CreateButton = styled(BaseButton)`
  margin: 0 0 0 auto;
  height: 35px;
`

const FormLabel = styled(Label)`
  font-size: 18px;
`

const Path = styled.span`
  font-size: 0.9rem;
  padding: 6px;
`

const PortalNameInput = styled(BaseInput)`
  max-width: 60px;
`

const PageNameInput = styled(BaseInput)`
  flex: 1;
  min-width: 0;
`

const UnderTreePathInput = styled(BaseInput)`
  flex: 1;
  margin-right: 8px;
`

export default PageCreationModal
