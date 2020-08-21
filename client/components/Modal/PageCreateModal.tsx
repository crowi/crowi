import React, { useCallback, useRef, useState, FC } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Button, Form, Input, Label, Modal, ModalBody, ModalHeader, ModalProps } from 'reactstrap'
import format from 'client/util/formatDate'
import styled from 'styled-components'

import { dark, gray, light } from '../../constants/colors'
import Crowi from 'client/util/Crowi'
import { isUserPage, parentPath } from 'server/util/view'

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

const CreateButton = styled(Button)`
  margin-left: auto;
`

const FormLabel = styled(Label)`
  font-size: 18px;
  width: 100%;
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

const CurrentPath = styled.code`
  word-break: break-all;
`

const UnderTreePathInput = styled(BaseInput)`
  flex: 1;
  margin-right: 8px;
`

interface Props extends ModalProps {
  crowi: Crowi
  toggle?: React.MouseEventHandler<any>
}

const PageCreateModal: FC<Props> = ({ crowi, fade = false, toggle, ...modalProps }) => {
  const user = crowi.getUser()
  const currentPath = location.pathname
  const userPath = `/user/${user && user.username}/`
  const datePath = format(new Date(), '/yyyy/MM/dd/')
  const isTopPage = currentPath === '/'

  const [t] = useTranslation()
  const [portalName, setPortalName] = useState<string>(t('Memo'))
  const [pageName, setPageName] = useState('')
  const [underTreePath, setUnderTreePath] = useState(decodeURI(parentPath(currentPath)))
  const wrapperRef = useRef<HTMLElement>(null)

  const onOpened = useCallback(() => {
    const inputList = wrapperRef.current?.querySelectorAll('input')
    if (inputList) {
      inputList[1].focus()
    }
  }, [])

  const createTodayPage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const href = `${userPath}${portalName || t('Memo')}${pageName ? datePath : datePath.slice(0, -1)}${pageName}`
    top.location.href = href
  }

  const createUnderTreePage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    top.location.href = underTreePath
  }

  return (
    <Modal innerRef={wrapperRef} fade={fade} toggle={toggle} onOpened={onOpened} {...modalProps}>
      <ModalHeader toggle={toggle}>{t('New Page')}</ModalHeader>
      <ModalBody>
        <FormLabel>{t("Create today's")}</FormLabel>
        <Form onSubmit={createTodayPage} inline>
          <TodayInputBox>
            <Path>{userPath}</Path>
            <PortalNameInput type="text" value={portalName} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPortalName(event.target.value)} />
            <Path>{datePath}</Path>
            <PageNameInput
              type="text"
              value={pageName}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPageName(event.target.value)}
              placeholder={t('Input page name (optional)')}
            />
          </TodayInputBox>
          <CreateButton color="primary">{t('Create')}</CreateButton>
        </Form>
        {!isTopPage && (
          <>
            <hr />
            <FormLabel>
              <Trans i18nKey="Create under">
                Create page under: <CurrentPath>{{ path: decodeURI(parentPath(currentPath)) }}</CurrentPath>
              </Trans>
            </FormLabel>
            <Form onSubmit={createUnderTreePage} inline>
              <UnderTreePathInput
                type="text"
                value={underTreePath}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setUnderTreePath(event.target.value)}
                placeholder={t('Input page name')}
              />
              <CreateButton color="primary" disabled={isUserPage(underTreePath)}>
                {t('Create')}
              </CreateButton>
            </Form>
          </>
        )}
      </ModalBody>
    </Modal>
  )
}

export default PageCreateModal
