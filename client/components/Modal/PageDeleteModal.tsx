import React, { FC, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, DropdownItem, Form, FormGroup, Label, Modal, ModalBody, ModalFooter, ModalHeader } from 'reactstrap'
import styled from 'styled-components'

import Icon from '../Common/Icon'
import { danger } from '../../constants/colors'
import Crowi from '../../../client/util/Crowi'

const TrashIcon = styled(Icon)<{ color?: string }>`
  ${({ color }) => `color: ${color}`};
  margin-right: 4px;
`

const FlexModalFooter = styled(ModalFooter)`
  display: flex;
  justify-content: space-between;
`

const FailedAlert = styled(Alert)`
  display: flex;
  margin: auto auto auto 0;
  padding: 0;
  height: 35px;
  height: 18px;
`

const ErrorText = styled.small`
  margin: 0 auto auto;
  padding: 0 4px 2px;
`

interface Props {
  crowi: Crowi
  pageId: string | null
  revisionId: string | null
}

const PageDeleteModal: FC<Props> = ({ crowi, pageId, revisionId }) => {
  const [t] = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const toggle = () => {
    setIsOpen(!isOpen)
  }

  const deletePage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      await crowi.apiPost('/pages.remove', {
        _csrf: crowi.csrfToken,
        path: crowi.location.pathname,
        page_id: pageId,
        revision_id: revisionId,
      })
      crowi.location.reload()
    } catch (err) {
      setErrorMessage(err.message)
    }
  }

  useEffect(() => {
    if (!isOpen) setErrorMessage('')
  }, [isOpen])

  return (
    <>
      <DropdownItem onClick={() => setIsOpen(true)}>
        <TrashIcon name="trashCanOutline" color={danger} />
        {t('Delete')}
      </DropdownItem>
      <Modal isOpen={isOpen} fade={false} toggle={toggle}>
        <Form role="form" onSubmit={deletePage}>
          <ModalHeader toggle={toggle}>
            <TrashIcon name="trashCanOutline" />
            Delete Page
          </ModalHeader>
          <ModalBody>
            <ul>
              <li>
                This page will be moved to the <a href="/trash/">trash</a>.
              </li>
            </ul>
            <FormGroup>
              <Label>This page:</Label>
              <br />
              <code>{decodeURI(crowi.location.pathname)}</code>
            </FormGroup>
          </ModalBody>
          <FlexModalFooter>
            <div>
              {errorMessage && (
                <FailedAlert color="danger">
                  <ErrorText>
                    <Icon name="alert" />
                    {errorMessage}
                  </ErrorText>
                </FailedAlert>
              )}
            </div>
            <Button color="danger">Delete!</Button>
          </FlexModalFooter>
        </Form>
      </Modal>
    </>
  )
}

export default PageDeleteModal
